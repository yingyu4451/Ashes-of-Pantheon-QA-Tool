using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace AshesOfPantheon.QA.EditorBridge
{
    internal sealed class QaGameReflectionAdapter
    {
        private const string GameAssembly = "HappyHotel";
        private static readonly IReadOnlyDictionary<string, string> ChineseNameFallbacks =
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["ArmorAttackBonusBuff"] = "护甲攻击增益",
                ["ParryCounterBuff"] = "招架反击",
                ["AureliaDashAttack"] = "奥蕾莉亚冲刺攻击",
                ["MultiAttackMainCharacter"] = "多次攻击玩家"
            };

        public object GetStatus()
        {
            return new
            {
                ready = true,
                mode = UnityEditor.EditorApplication.isPlaying ? "editor-play" : "editor-edit",
                gameVersion = Application.version,
                sceneName = SceneManager.GetActiveScene().name,
                unityVersion = Application.unityVersion,
                timestamp = DateTime.UtcNow.ToString("O")
            };
        }

        public object GetCatalog()
        {
            var cards = GetCards();
            return new
            {
                cards,
                equipment = cards.Where(card => string.Equals(card.category, "equipment", StringComparison.Ordinal)).Select(card => new { card.typeId, card.name }).ToList(),
                buffs = GetRegistryEntries("HappyHotel.Buff.BuffRegistry", "buffNameLocalized").Select(entry => new { typeId = entry.typeId, name = entry.name, description = entry.description, supportsStacks = true, supportsDuration = true }).ToList(),
                blessings = GetRegistryEntries("HappyHotel.Donum.DonumRegistry", "itemNameLocalized").Select(entry => new { typeId = entry.typeId, name = entry.name, description = entry.description }).ToList(),
                intents = GetRegistryEntries("HappyHotel.Intent.IntentRegistry", "intentNameLocalized").Select(entry => new { typeId = entry.typeId, name = entry.name, description = entry.description, parameters = Array.Empty<string>() }).ToList()
            };
        }

        public object GetCardInventorySnapshot()
        {
            if (!UnityEditor.EditorApplication.isPlaying)
                return new { available = false, cards = Array.Empty<object>() };

            var inventory = GetSingleton("HappyHotel.Inventory.CardInventory");
            if (inventory == null)
                return new { available = false, cards = Array.Empty<object>() };

            RefreshHandDisplay();
            var cards = GetVisibleHandCards(inventory)
                .Concat(GetDeployedEquipmentCards())
                .Distinct()
                .Where(card => card != null)
                .Select(ResolveTypeId)
                .Where(typeId => !string.IsNullOrWhiteSpace(typeId))
                .GroupBy(typeId => typeId, StringComparer.Ordinal)
                .Select(group => new { typeId = group.Key, count = group.Count() })
                .OrderBy(card => card.typeId, StringComparer.Ordinal)
                .ToList();
            return new { available = true, cards };
        }

        public object AddOwnedCard(JObject request)
        {
            if (!UnityEditor.EditorApplication.isPlaying) return Failure("请先进入 Play Mode。");
            var typeIdText = request.Value<string>("typeId");
            var inventory = GetSingleton("HappyHotel.Inventory.CardInventory");
            var registry = GetSingleton("HappyHotel.Card.CardRegistry");
            var drawManager = GetSingleton("HappyHotel.Inventory.CardDrawManager");
            var cardManager = GetSingleton("HappyHotel.Card.CardManager");
            if (inventory == null || registry == null || drawManager == null || cardManager == null)
                return Failure("手牌模块尚未初始化。");
            Invoke(registry, "Initialize");
            var typeId = Invoke(registry, "GetType", typeIdText);
            if (typeId == null) return Failure($"未注册的卡牌 TypeId：{typeIdText}");
            var card = GetCardFromZone(inventory, typeId, "Deck") ?? GetCardFromZone(inventory, typeId, "Discard");
            var created = false;
            if (card == null)
            {
                if (!(Invoke(inventory, "AddCard", typeId, null) is bool added) || !added)
                    return Failure($"无法创建卡牌：{typeIdText}");
                created = true;
                card = GetCardFromZone(inventory, typeId, "Deck");
            }
            if (card == null || !(Invoke(drawManager, "DrawCard", card) is bool drawn) || !drawn)
            {
                if (created && card != null && Invoke(inventory, "RemoveCard", card) is bool removed && removed)
                    ReleaseCardInstance(cardManager, card);
                return Failure($"无法将卡牌加入手牌：{typeIdText}");
            }
            return Success($"已加入手牌：{typeIdText}");
        }

        public object RemoveOwnedCard(JObject request)
        {
            if (!UnityEditor.EditorApplication.isPlaying) return Failure("请先进入 Play Mode。");
            var typeIdText = request.Value<string>("typeId");
            var inventory = GetSingleton("HappyHotel.Inventory.CardInventory");
            var cardManager = GetSingleton("HappyHotel.Card.CardManager");
            if (inventory == null || cardManager == null) return Failure("卡牌库存尚未初始化。");
            var deploymentService = GetSingleton("HappyHotel.Inventory.EquipmentCardDeploymentService");
            foreach (var card in GetDeployedEquipmentCards().Where(card => string.Equals(ResolveTypeId(card), typeIdText, StringComparison.Ordinal)))
            {
                if (!TryGetEquipmentBinding(deploymentService, card, out var prop)) continue;
                var propController = GetSingleton("HappyHotel.Prop.PropController");
                var reasonType = FindType("HappyHotel.Prop.PropRemovalReason");
                if (propController == null || reasonType == null || prop == null)
                    return Failure("场上装备的移除模块不可用。");
                var isTemporary = Invoke(deploymentService, "IsTemporary", card) is bool temporary && temporary;
                var removed = Invoke(propController, "RemoveProp", prop, Enum.Parse(reasonType, "RunReset"));
                if (!(removed is bool removedValue) || !removedValue)
                    return Failure($"无法删除场上装备：{typeIdText}");
                if (!isTemporary) ReleaseCardInstance(cardManager, card);
                return Success($"已删除场上装备：{typeIdText}");
            }

            var target = GetVisibleHandCards(inventory)
                .FirstOrDefault(card => string.Equals(ResolveTypeId(card), typeIdText, StringComparison.Ordinal));
            if (target == null) return Failure($"手牌中没有可删除的卡牌：{typeIdText}");
            if (!(Invoke(inventory, "RemoveCard", target) is bool removedCard) || !removedCard)
                return Failure($"无法从手牌删除卡牌：{typeIdText}");
            ReleaseCardInstance(cardManager, target);
            RefreshHandDisplay();
            return Success($"已从手牌删除卡牌：{typeIdText}");
        }

        public object GetBattleSnapshot()
        {
            if (!UnityEditor.EditorApplication.isPlaying)
            {
                return new
                {
                    available = false,
                    sceneName = SceneManager.GetActiveScene().name,
                    mapName = string.Empty,
                    width = 0,
                    height = 0,
                    turn = 0,
                    phase = "editor-edit",
                    player = (object)null,
                    entities = Array.Empty<object>()
                };
            }

            var mapSize = GetMapSize();
            var characters = GetControllerObjects("HappyHotel.Character.CharacterController", "GetAllCharacters");
            var enemies = GetControllerObjects("HappyHotel.Enemy.EnemyController", "GetAllEnemies");
            var playerObject = characters.FirstOrDefault(IsMainCharacter);
            var player = BuildPlayer(playerObject);
            var enemyDtos = enemies.Select((enemy, index) => BuildEntity(enemy, "enemy", index)).Where(value => value != null).ToList();

            return new
            {
                available = true,
                sceneName = SceneManager.GetActiveScene().name,
                mapName = ResolveCurrentMapName(),
                width = mapSize.x,
                height = mapSize.y,
                turn = 0,
                phase = "runtime",
                player,
                entities = enemyDtos.Concat(GetEquipmentEntities()).ToList()
            };
        }

        public object ExecuteGm(string command)
        {
            if (string.IsNullOrWhiteSpace(command))
            {
                return new { success = false, message = "Command is empty." };
            }

            var type = FindType("HappyHotel.Core.Debugging.GMCommandProcessor");
            var method = type?.GetMethod("Execute", BindingFlags.Public | BindingFlags.Static);
            if (method == null)
            {
                return new { success = false, message = "GMCommandProcessor.Execute is unavailable." };
            }

            var result = method.Invoke(null, new object[] { command });
            return new
            {
                success = ReadMember<bool>(result, "Success"),
                message = ReadMember<string>(result, "Message") ?? string.Empty,
                logType = ReadMember<object>(result, "LogType")?.ToString()
            };
        }

        public object ApplyPlayer(JObject request)
        {
            var player = GetControllerObjects("HappyHotel.Character.CharacterController", "GetAllCharacters").FirstOrDefault(IsMainCharacter);
            if (player == null) return Failure("Main character is unavailable.");
            var hp = GetBehaviorComponent(player, "HappyHotel.Core.ValueProcessing.Components.HitPointValueComponent");
            var cost = GetSingleton("HappyHotel.GameManager.CostManager");
            if (hp == null || cost == null) return Failure("Player value modules are unavailable.");

            Invoke(hp, "SetHitPoint", request.Value<int>("maxHp"), request.Value<int>("currentHp"));
            Invoke(cost, "SetCost", request.Value<int>("currentCost"), request.Value<int>("maxCost"), true);
            return Success("Player values updated.");
        }

        public object ApplyEnemy(JObject request)
        {
            var enemy = FindTarget(request.Value<string>("instanceId"));
            if (enemy == null) return Failure("Enemy instance is unavailable.");
            var hp = GetBehaviorComponent(enemy, "HappyHotel.Core.ValueProcessing.Components.HitPointValueComponent");
            var attack = GetBehaviorComponent(enemy, "HappyHotel.Core.ValueProcessing.Components.AttackPowerComponent");
            if (hp == null || attack == null) return Failure("Enemy value modules are unavailable.");

            Invoke(hp, "SetHitPoint", request.Value<int>("maxHp"), request.Value<int>("currentHp"));
            Invoke(attack, "SetAttackPower", request.Value<int>("attack"));
            return Success("Enemy values updated.");
        }

        public object AddBuff(JObject request)
        {
            var target = FindTarget(request.Value<string>("targetInstanceId"));
            var typeIdText = request.Value<string>("typeId");
            var container = GetBehaviorComponent(target, "HappyHotel.Buff.Components.BuffContainer");
            var manager = GetSingleton("HappyHotel.Buff.BuffManager");
            var registry = GetSingleton("HappyHotel.Buff.BuffRegistry");
            if (target == null || container == null || manager == null || registry == null) return Failure("BUFF target or manager is unavailable.");

            Invoke(registry, "Initialize");
            var typeId = Invoke(registry, "GetType", typeIdText);
            if (typeId == null) return Failure($"BUFF TypeId is not registered: {typeIdText}");
            var setting = CreateSetting(registry, typeId, request);
            var buff = Invoke(manager, "Create", typeId, setting);
            if (buff == null) return Failure("BUFF creation failed.");
            Invoke(container, "AddBuff", buff);
            return Success("BUFF added.");
        }

        public object RemoveBuff(JObject request)
        {
            var target = FindTarget(request.Value<string>("targetInstanceId"));
            var container = GetBehaviorComponent(target, "HappyHotel.Buff.Components.BuffContainer");
            if (container == null) return Failure("BUFF target is unavailable.");
            var buffs = Enumerate(Invoke(container, "GetAllBuffs")).ToList();
            var index = ParseIndexedInstance(request.Value<string>("instanceId"), "buff-");
            if (index < 0 || index >= buffs.Count) return Failure("BUFF instance is unavailable.");
            Invoke(container, "RemoveBuff", buffs[index]);
            return Success("BUFF removed.");
        }

        public object AddBlessing(JObject request)
        {
            var manager = GetSingleton("HappyHotel.Donum.DonumManager");
            var registry = GetSingleton("HappyHotel.Donum.DonumRegistry");
            var typeIdText = request.Value<string>("typeId");
            if (manager == null || registry == null) return Failure("Blessing manager is unavailable.");
            Invoke(registry, "Initialize");
            var typeId = Invoke(registry, "GetType", typeIdText);
            if (typeId == null) return Failure($"Blessing TypeId is not registered: {typeIdText}");
            var blessing = Invoke(manager, "Create", typeId, null);
            return blessing == null ? Failure("Blessing creation failed.") : Success("Blessing added.");
        }

        public object RemoveBlessing(JObject request)
        {
            var manager = GetSingleton("HappyHotel.Donum.DonumManager");
            var typeIdText = request.Value<string>("typeId");
            if (manager == null) return Failure("Blessing manager is unavailable.");
            var blessing = Enumerate(Invoke(manager, "GetAllObjects")).FirstOrDefault(item => string.Equals(ResolveTypeId(item), typeIdText, StringComparison.Ordinal));
            if (blessing == null) return Failure("Blessing instance is unavailable.");
            Invoke(manager, "Remove", blessing);
            return Success("Blessing removed.");
        }

        public object ApplyIntents(JObject request)
        {
            var enemy = FindTarget(request.Value<string>("instanceId"));
            var executor = GetBehaviorComponent(enemy, "HappyHotel.Intent.Components.TurnEndIntentExecutorComponent");
            var registry = GetSingleton("HappyHotel.Intent.IntentRegistry");
            var executorType = FindType("HappyHotel.Intent.Components.TurnEndIntentExecutorComponent");
            var planType = executorType?.GetNestedType("IntentPlan", BindingFlags.Public);
            if (executor == null || registry == null || planType == null) return Failure("Intent modules are unavailable.");

            Invoke(registry, "Initialize");
            var listType = typeof(List<>).MakeGenericType(planType);
            var plans = (IList)Activator.CreateInstance(listType);
            foreach (var step in request["steps"] as JArray ?? new JArray())
            {
                var typeIdText = step.Value<string>("typeId");
                var typeId = Invoke(registry, "GetType", typeIdText);
                if (typeId == null) return Failure($"Intent TypeId is not registered: {typeIdText}");
                var plan = Activator.CreateInstance(planType);
                WriteMember(plan, "TypeId", typeId);
                WriteMember(plan, "Setting", CreateSetting(registry, typeId, step["parameters"] as JObject));
                WriteMember(plan, "ProjectileClassId", string.Empty);
                plans.Add(plan);
            }

            var method = executor.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(candidate => candidate.Name == "SetSequenceWithLoopStart" && candidate.GetParameters().Length == 2);
            if (method == null) return Failure("Intent sequence setter is unavailable.");
            method.Invoke(executor, new object[] { plans, request.Value<int>("loopStartIndex") });
            return Success("Intent sequence updated.");
        }

        private List<CardDto> GetCards()
        {
            var registry = GetSingleton("HappyHotel.Card.CardRegistry");
            if (registry == null)
            {
                return new List<CardDto>();
            }

            Invoke(registry, "Initialize");
            var result = new List<CardDto>();
            foreach (var entry in Enumerate(Invoke(registry, "GetAllIndexEntries")))
            {
                var typeId = ReadMember<string>(entry, "TypeId");
                var template = ReadMember<object>(entry, "template");
                if (string.IsNullOrWhiteSpace(typeId) || template == null)
                {
                    continue;
                }

                var name = ResolveTemplateText(template, "itemNameLocalized", "ItemNames", "Name", typeId);
                var description = ResolveTemplateText(template, "descriptionLocalized", "ItemDescriptions", "Description", typeId);
                result.Add(new CardDto
                {
                    typeId = typeId,
                    name = ResolveChineseName(typeId, name),
                    description = description ?? string.Empty,
                    category = ResolveCardCategory(template),
                    cost = ReadMember<int>(template, "cardCost"),
                    rarity = (ReadMember<object>(template, "rarity")?.ToString() ?? "Common").ToLowerInvariant(),
                    tags = Enumerate(ReadMember<object>(template, "cardTagIds")).Select(value => value?.ToString()).Where(value => !string.IsNullOrWhiteSpace(value)).ToArray(),
                    imageUrl = EncodeSprite(ReadMember<Sprite>(template, "cardImage") ?? ReadMember<Sprite>(template, "icon")),
                    frameVariant = ResolveFrameVariant(ReadMember<object>(template, "rarity")?.ToString())
                });
            }

            return result.OrderBy(card => card.typeId, StringComparer.Ordinal).ToList();
        }

        private IEnumerable<RegistryEntryDto> GetRegistryEntries(string registryTypeName, string localizedNameField)
        {
            var registry = GetSingleton(registryTypeName);
            if (registry == null)
            {
                return Array.Empty<RegistryEntryDto>();
            }

            Invoke(registry, "Initialize");
            var entries = new List<RegistryEntryDto>();
            foreach (var entry in Enumerate(Invoke(registry, "GetAllIndexEntries")))
            {
                var typeId = ReadMember<string>(entry, "TypeId");
                if (!string.IsNullOrWhiteSpace(typeId))
                {
                    var template = ReadMember<object>(entry, "TemplateObject") ?? ReadMember<object>(entry, "template");
                    var name = ResolveTemplateText(template, localizedNameField, "ItemNames", "Name", typeId);
                    var description = ResolveTemplateText(template, "descriptionLocalized", "ItemDescriptions", "Description", typeId);
                    entries.Add(new RegistryEntryDto
                    {
                        typeId = typeId,
                        name = ResolveChineseName(typeId, name),
                        description = description ?? string.Empty
                    });
                }
            }

            return entries.OrderBy(entry => entry.typeId, StringComparer.Ordinal);
        }


        private IEnumerable<object> GetEquipmentEntities()
        {
            var controller = GetSingleton("HappyHotel.Prop.PropController");
            var equipmentType = FindType("HappyHotel.Prop.EquipmentPropBase");
            var method = controller?.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(candidate => candidate.Name == "GetAllPropsOfType" && candidate.IsGenericMethodDefinition &&
                    candidate.GetGenericArguments().Length == 1 && candidate.GetParameters().Length == 0);
            if (method == null || equipmentType == null) yield break;
            var deployment = GetSingleton("HappyHotel.Inventory.EquipmentCardDeploymentService");
            var visualType = FindType("HappyHotel.Prop.PropVisualController");
            foreach (var prop in Enumerate(method.MakeGenericMethod(equipmentType).Invoke(controller, null)).Distinct())
            {
                if (prop == null || prop is UnityEngine.Object unityObject && unityObject == null) continue;
                var visual = visualType == null ? null : Invoke(prop, "GetComponent", visualType);
                if (ReadMember<bool>(visual, "IsDisappearPlaying")) continue;
                var card = Invoke(prop, "GetSourceEquipment");
                if (card != null && deployment != null && Invoke(deployment, "IsBound", card) is bool bound && !bound) continue;
                var typeId = ResolveTypeId(card ?? prop);
                var definition = ResolveRegistryEntry("HappyHotel.Card.CardRegistry", typeId, "itemNameLocalized");
                var point = GetGridPosition(prop);
                var id = prop is UnityEngine.Object obj ? obj.GetInstanceID().ToString() : System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(prop).ToString();
                yield return new {
                    instanceId = $"equipment#{id}", typeId, definition.name, kind = "equipment",
                    position = new { x = point.x, y = point.y }, buffs = Array.Empty<object>()
                };
            }
        }

        private object BuildPlayer(object player)
        {
            if (player == null)
            {
                return new
                {
                    instanceId = "player-main",
                    name = "Main Character",
                    position = new { x = 0, y = 0 },
                    currentHp = 0,
                    maxHp = 0,
                    currentCost = 0,
                    maxCost = 0,
                    blessings = Array.Empty<object>(),
                    buffs = Array.Empty<object>()
                };
            }

            var hp = GetBehaviorComponent(player, "HappyHotel.Core.ValueProcessing.Components.HitPointValueComponent");
            var costManager = GetSingleton("HappyHotel.GameManager.CostManager");
            var donumManager = GetSingleton("HappyHotel.Donum.DonumManager");
            var position = GetGridPosition(player);
            return new
            {
                instanceId = "player-main",
                name = ReadMember<string>(player, "CharacterId") ?? "Main Character",
                position = new { x = position.x, y = position.y },
                currentHp = ReadMember<int>(hp, "CurrentHitPoint"),
                maxHp = ReadMember<int>(hp, "MaxHitPoint"),
                currentCost = ReadMember<int>(costManager, "CurrentCost"),
                maxCost = ReadMember<int>(costManager, "MaxCost"),
                blessings = donumManager == null
                    ? Array.Empty<object>()
                    : Enumerate(Invoke(donumManager, "GetAllObjects")).Select(donum =>
                    {
                        var definition = ResolveRegistryEntry("HappyHotel.Donum.DonumRegistry", ResolveTypeId(donum), "itemNameLocalized");
                        return new { definition.typeId, definition.name, definition.description };
                    }).Cast<object>().ToArray(),
                buffs = GetBuffs(player)
            };
        }

        private object BuildEntity(object target, string kind, int index)
        {
            if (target == null)
            {
                return null;
            }

            var hp = GetBehaviorComponent(target, "HappyHotel.Core.ValueProcessing.Components.HitPointValueComponent");
            var attack = GetBehaviorComponent(target, "HappyHotel.Core.ValueProcessing.Components.AttackPowerComponent");
            var executor = GetBehaviorComponent(target, "HappyHotel.Intent.Components.TurnEndIntentExecutorComponent");
            var position = GetGridPosition(target);
            var typeId = ResolveTypeId(target);
            return new
            {
                instanceId = $"{typeId}#{index}",
                typeId,
                name = Humanize(typeId),
                kind,
                position = new { x = position.x, y = position.y },
                currentHp = ReadMember<int>(hp, "CurrentHitPoint"),
                maxHp = ReadMember<int>(hp, "MaxHitPoint"),
                attack = ReadMember<int>(attack, "AttackPower"),
                buffs = GetBuffs(target),
                intents = GetIntents(executor),
                loopStartIndex = executor == null ? -1 : Convert.ToInt32(Invoke(executor, "GetLoopStartIndex"))
            };
        }

        private object[] GetIntents(object executor)
        {
            if (executor == null) return Array.Empty<object>();
            return Enumerate(Invoke(executor, "GetSequence")).Select((plan, index) =>
            {
                var rawTypeId = ReadMember<object>(plan, "TypeId");
                var typeId = ReadMember<string>(rawTypeId, "Id") ?? rawTypeId?.ToString() ?? "Unknown";
                var definition = ResolveRegistryEntry("HappyHotel.Intent.IntentRegistry", typeId, "intentNameLocalized");
                return new
                {
                    instanceId = $"intent-{index}",
                    typeId,
                    name = definition.name,
                    summary = definition.description,
                    parameters = new Dictionary<string, object>()
                };
            }).Cast<object>().ToArray();
        }

        private object[] GetBuffs(object target)
        {
            var container = GetBehaviorComponent(target, "HappyHotel.Buff.Components.BuffContainer");
            var buffs = container == null ? Array.Empty<object>() : Enumerate(Invoke(container, "GetAllBuffs")).ToArray();
            return buffs.Select((buff, index) =>
            {
                var definition = ResolveRegistryEntry("HappyHotel.Buff.BuffRegistry", ResolveTypeId(buff), "buffNameLocalized");
                return new
                {
                    instanceId = $"buff-{index}",
                    definition.typeId,
                    definition.name,
                    stacks = 1,
                    definition.description
                };
            }).Cast<object>().ToArray();
        }

        private static Vector2Int GetMapSize()
        {
            var manager = GetSingleton("HappyHotel.Map.LevelMapManager");
            var value = manager == null ? null : Invoke(manager, "GetMapSize");
            return value is Vector2Int size ? size : new Vector2Int(9, 9);
        }

        private static string ResolveCurrentMapName()
        {
            var manager = GetSingleton("HappyHotel.Map.LevelMapStorageManager");
            var data = manager == null ? null : Invoke(manager, "GetCurrentMapData");
            return ReadMember<string>(data, "mapName") ?? SceneManager.GetActiveScene().name;
        }

        private static List<object> GetControllerObjects(string typeName, string methodName)
        {
            var controller = GetSingleton(typeName);
            return controller == null ? new List<object>() : Enumerate(Invoke(controller, methodName)).ToList();
        }

        private static bool IsMainCharacter(object character)
        {
            if (string.Equals(ReadMember<string>(character, "CharacterId"), "MainCharacter", StringComparison.Ordinal))
            {
                return true;
            }

            return character is Component component && component.CompareTag("MainCharacter");
        }

        private static Vector2Int GetGridPosition(object target)
        {
            var grid = GetBehaviorComponent(target, "HappyHotel.Core.Grid.Components.GridObjectComponent");
            var value = grid == null ? null : Invoke(grid, "GetGridPosition");
            return value is Vector2Int point ? point : Vector2Int.zero;
        }

        private static object GetBehaviorComponent(object target, string componentTypeName)
        {
            var componentType = FindType(componentTypeName);
            if (target == null || componentType == null)
            {
                return null;
            }

            var method = target.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(candidate => candidate.Name == "GetBehaviorComponent" && candidate.IsGenericMethodDefinition && candidate.GetGenericArguments().Length == 1 && candidate.GetParameters().Length == 0);
            return method?.MakeGenericMethod(componentType).Invoke(target, null);
        }

        private static string ResolveTypeId(object target)
        {
            var raw = ReadMember<object>(target, "TypeId") ?? ReadMember<object>(target, "typeId");
            return ReadMember<string>(raw, "Id") ?? raw?.ToString() ?? target?.GetType().Name ?? "Unknown";
        }

        private static string ResolveLocalized(object localizedString)
        {
            if (localizedString == null)
            {
                return string.Empty;
            }

            var resolver = FindType("HappyHotel.Core.Localization.LocalizedStringResolver");
            var method = resolver?.GetMethod("Resolve", BindingFlags.Public | BindingFlags.Static);
            return method?.Invoke(null, new[] { localizedString }) as string ?? string.Empty;
        }

        private static string ResolveTemplateText(
            object template,
            string localizedFieldName,
            string tableName,
            string keySuffix,
            string typeId)
        {
            if (template == null) return string.Empty;
            var localizedString = ReadMember<object>(template, localizedFieldName);
            var editorUtility = FindType("HappyHotel.Core.Localization.Editor.LocalizedStringTableEditorUtility");
            var getLocaleText = editorUtility?.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .FirstOrDefault(method => method.Name == "GetLocaleText" && method.GetParameters().Length == 3);
            var localized = getLocaleText?.Invoke(null, new[] { localizedString, "zh-Hans", string.Empty }) as string;
            if (!string.IsNullOrWhiteSpace(localized)) return localized;

            var prefixCandidates = new List<string>();
            var declaredPrefix = ReadMember<string>(template, "LocalizationSystemPrefix");
            if (!string.IsNullOrWhiteSpace(declaredPrefix)) prefixCandidates.Add(declaredPrefix);
            if (IsInstanceOf(template, "HappyHotel.Card.Templates.EquipmentTemplate")) prefixCandidates.Add("Equipment");
            if (IsInstanceOf(template, "HappyHotel.Card.Templates.CardTemplate")) prefixCandidates.Add("Card");

            var slugCandidates = new List<string>();
            var declaredSlug = ReadMember<string>(template, "localizationSlug");
            if (!string.IsNullOrWhiteSpace(declaredSlug)) slugCandidates.Add(declaredSlug);
            var sourceName = template is UnityEngine.Object unityObject ? unityObject.name : template.GetType().Name;
            var projectSlug = InvokeStatic("HappyHotel.Core.Localization.LocalizationSlugUtility", "BuildSlug", sourceName, "item") as string;
            if (!string.IsNullOrWhiteSpace(projectSlug)) slugCandidates.Add(projectSlug);
            var templateSlug = ToKebabCase(sourceName);
            if (!string.IsNullOrWhiteSpace(templateSlug)) slugCandidates.Add(templateSlug);
            var typeSlug = ToKebabCase(typeId);
            if (!string.IsNullOrWhiteSpace(typeSlug))
            {
                slugCandidates.Add(typeSlug);
                slugCandidates.Add($"{typeSlug}-template");
            }

            var authority = FindType("HappyHotel.Core.Localization.Editor.LocalizationTableAuthorityReferenceUtility");
            var tryGetLocaleText = authority?.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .FirstOrDefault(method => method.Name == "TryGetLocaleText" && method.GetParameters().Length == 4);
            foreach (var prefix in prefixCandidates.Distinct(StringComparer.Ordinal))
            {
                foreach (var slug in slugCandidates.Where(candidate => !string.IsNullOrWhiteSpace(candidate)).Distinct(StringComparer.Ordinal))
                {
                    var arguments = new object[] { tableName, $"{prefix}/{slug}/{keySuffix}", "zh-Hans", null };
                    if (tryGetLocaleText?.Invoke(null, arguments) is true && arguments[3] is string derivedText &&
                        !string.IsNullOrWhiteSpace(derivedText))
                    {
                        return derivedText;
                    }
                }
            }

            return ResolveLocalized(localizedString);
        }

        private static RegistryEntryDto ResolveRegistryEntry(
            string registryTypeName,
            string typeId,
            string localizedNameField)
        {
            var registry = GetSingleton(registryTypeName);
            if (registry != null)
            {
                Invoke(registry, "Initialize");
                var registeredType = Invoke(registry, "GetType", typeId);
                var entry = registeredType == null ? null : Invoke(registry, "GetIndexEntry", registeredType);
                var template = ReadMember<object>(entry, "TemplateObject") ?? ReadMember<object>(entry, "template");
                if (template == null && registeredType != null)
                {
                    var resourceManager = Invoke(GetSingleton(registryTypeName.Replace("Registry", "Manager")), "GetResourceManager");
                    template = Invoke(resourceManager, "GetTemplate", registeredType);
                }
                var name = ResolveTemplateText(template, localizedNameField, "ItemNames", "Name", typeId);
                var description = ResolveTemplateText(template, "descriptionLocalized", "ItemDescriptions", "Description", typeId);
                return new RegistryEntryDto
                {
                    typeId = typeId,
                    name = ResolveChineseName(typeId, name),
                    description = description ?? string.Empty
                };
            }

            return new RegistryEntryDto { typeId = typeId, name = ResolveChineseName(typeId, string.Empty), description = string.Empty };
        }

        private static string ResolveCardCategory(object template)
        {
            if (IsInstanceOf(template, "HappyHotel.Card.Templates.EquipmentTemplate")) return "equipment";
            if (IsInstanceOf(template, "HappyHotel.Card.Templates.DirectionalPlacementCardTemplate")) return "directional";
            if (IsInstanceOf(template, "HappyHotel.Card.Templates.TargetSelectionCardTemplate")) return "target";
            if (IsInstanceOf(template, "HappyHotel.Card.Templates.ActivePlacementCardTemplate")) return "placement";
            return "effect";
        }

        private static bool IsInstanceOf(object value, string typeName)
        {
            var type = FindType(typeName);
            return value != null && type != null && type.IsInstanceOfType(value);
        }

        private static string ToKebabCase(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return string.Empty;
            var builder = new System.Text.StringBuilder(value.Length + 12);
            for (var index = 0; index < value.Length; index++)
            {
                var character = value[index];
                var previous = index > 0 ? value[index - 1] : '\0';
                var next = index + 1 < value.Length ? value[index + 1] : '\0';
                var startsWord = index > 0 && char.IsUpper(character) &&
                    (char.IsLower(previous) || char.IsDigit(previous) || char.IsUpper(previous) && char.IsLower(next));
                if (startsWord && builder.Length > 0 && builder[builder.Length - 1] != '-') builder.Append('-');
                if (char.IsLetterOrDigit(character))
                {
                    builder.Append(char.ToLowerInvariant(character));
                }
                else if (builder.Length > 0 && builder[builder.Length - 1] != '-')
                {
                    builder.Append('-');
                }
            }
            return builder.ToString().Trim('-');
        }

        private static int ResolveFrameVariant(string rarity)
        {
            return rarity switch
            {
                "Rare" => 1,
                "Epic" => 2,
                "Legendary" => 3,
                _ => 0
            };
        }

        private static string EncodeSprite(Sprite sprite)
        {
            if (sprite == null || sprite.texture == null) return null;
            var rect = sprite.rect;
            var scale = Mathf.Min(1f, 320f / Mathf.Max(rect.width, rect.height));
            var width = Mathf.Max(1, Mathf.RoundToInt(rect.width * scale));
            var height = Mathf.Max(1, Mathf.RoundToInt(rect.height * scale));
            var renderTexture = RenderTexture.GetTemporary(width, height, 0, RenderTextureFormat.ARGB32);
            var previous = RenderTexture.active;
            Texture2D output = null;
            try
            {
                var uvScale = new Vector2(rect.width / sprite.texture.width, rect.height / sprite.texture.height);
                var uvOffset = new Vector2(rect.x / sprite.texture.width, rect.y / sprite.texture.height);
                Graphics.Blit(sprite.texture, renderTexture, uvScale, uvOffset);
                RenderTexture.active = renderTexture;
                output = new Texture2D(width, height, TextureFormat.RGBA32, false);
                output.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                output.Apply();
                return $"data:image/png;base64,{Convert.ToBase64String(output.EncodeToPNG())}";
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.LogWarning($"[AshesOfPantheonQA] Card image export failed for {sprite.name}: {exception.Message}");
                return null;
            }
            finally
            {
                if (output != null) UnityEngine.Object.DestroyImmediate(output);
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(renderTexture);
            }
        }

        private static object FindTarget(string instanceId)
        {
            if (string.Equals(instanceId, "player-main", StringComparison.Ordinal))
            {
                return GetControllerObjects("HappyHotel.Character.CharacterController", "GetAllCharacters").FirstOrDefault(IsMainCharacter);
            }

            var separator = instanceId?.LastIndexOf('#') ?? -1;
            if (separator <= 0 || !int.TryParse(instanceId.Substring(separator + 1), out var index)) return null;
            var enemies = GetControllerObjects("HappyHotel.Enemy.EnemyController", "GetAllEnemies");
            if (index < 0 || index >= enemies.Count) return null;
            var enemy = enemies[index];
            return string.Equals(ResolveTypeId(enemy), instanceId.Substring(0, separator), StringComparison.Ordinal) ? enemy : null;
        }

        private static object CreateSetting(object registry, object typeId, JObject values)
        {
            var entry = Invoke(registry, "GetIndexEntry", typeId);
            var settingType = ReadMember<Type>(entry, "SettingType");
            if (settingType == null) return null;
            var setting = Activator.CreateInstance(settingType);
            if (values == null) return setting;

            foreach (var property in values.Properties())
            {
                WriteConvertedMember(setting, property.Name, property.Value);
            }

            WriteConvertedMember(setting, "stack", values["stacks"]);
            WriteConvertedMember(setting, "stackCount", values["stacks"]);
            WriteConvertedMember(setting, "turns", values["duration"]);
            WriteConvertedMember(setting, "remainingTurns", values["duration"]);
            return setting;
        }

        private static void WriteConvertedMember(object target, string name, JToken token)
        {
            if (target == null || token == null) return;
            var type = target.GetType();
            var property = type.GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                .FirstOrDefault(candidate => string.Equals(candidate.Name, name, StringComparison.OrdinalIgnoreCase) && candidate.CanWrite);
            if (property != null)
            {
                property.SetValue(target, token.ToObject(property.PropertyType));
                return;
            }

            var field = type.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                .FirstOrDefault(candidate => string.Equals(candidate.Name, name, StringComparison.OrdinalIgnoreCase));
            if (field != null) field.SetValue(target, token.ToObject(field.FieldType));
        }

        private static void WriteMember(object target, string name, object value)
        {
            if (target == null) return;
            var type = target.GetType();
            var field = type.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (field != null)
            {
                field.SetValue(target, value);
                return;
            }

            var property = type.GetProperty(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (property?.CanWrite == true) property.SetValue(target, value);
        }

        private static int ParseIndexedInstance(string value, string prefix)
        {
            if (string.IsNullOrEmpty(value) || !value.StartsWith(prefix, StringComparison.Ordinal)) return -1;
            return int.TryParse(value.Substring(prefix.Length), out var index) ? index : -1;
        }

        private static object Success(string message)
        {
            return new { success = true, message };
        }

        private static object Failure(string message)
        {
            return new { success = false, message };
        }

        private static bool TryGetEquipmentBinding(object deploymentService, object card, out object prop)
        {
            prop = null;
            if (deploymentService == null || card == null) return false;
            var method = deploymentService.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(candidate => candidate.Name == "TryGetBinding" &&
                                             candidate.GetParameters().Length == 3 &&
                                             candidate.GetParameters()[0].ParameterType.IsInstanceOfType(card));
            if (method == null) return false;
            var arguments = new[] { card, null, null };
            var result = method.Invoke(deploymentService, arguments);
            prop = arguments[2];
            return result is bool found && found && prop != null;
        }

        private static List<object> GetVisibleHandCards(object inventory)
        {
            var handZone = GetCardZone("Hand");
            if (inventory == null || handZone == null) return new List<object>();
            var temporaryCards = Enumerate(Invoke(inventory, "GetTemporaryCards")).ToList();
            return Enumerate(Invoke(inventory, "GetCardsInZone", handZone))
                .Where(card => card != null && !temporaryCards.Any(temporary => ReferenceEquals(temporary, card)))
                .Distinct()
                .ToList();
        }

        private static List<object> GetDeployedEquipmentCards()
        {
            return Enumerate(Invoke(GetSingleton("HappyHotel.Inventory.EquipmentCardDeploymentService"), "GetBoundCards"))
                .Where(card => card != null)
                .Distinct()
                .ToList();
        }

        private static object GetCardFromZone(object inventory, object typeId, string zoneName)
        {
            var zone = GetCardZone(zoneName);
            return zone == null ? null : Invoke(inventory, "GetCardByTypeId", typeId, zone);
        }

        private static object GetCardZone(string zoneName)
        {
            var inventoryType = FindType("HappyHotel.Inventory.CardInventory");
            var zoneType = inventoryType?.GetNestedType("CardZone", BindingFlags.Public);
            return zoneType == null ? null : Enum.Parse(zoneType, zoneName);
        }

        private static void RefreshHandDisplay()
        {
            Invoke(GetSingleton("HappyHotel.HandFan.HandCardPanel"), "RefreshDisplay");
        }

        private static void ReleaseCardInstance(object cardManager, object card)
        {
            if (card == null) return;
            Invoke(cardManager, "Remove", card);
            Invoke(card, "Dispose");
        }

        private static string Humanize(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "Unknown";
            var result = new System.Text.StringBuilder(value.Length + 8);
            for (var index = 0; index < value.Length; index++)
            {
                var character = value[index];
                if (index > 0 && char.IsUpper(character) && !char.IsUpper(value[index - 1])) result.Append(' ');
                result.Append(character);
            }
            return result.ToString();
        }

        private static string ResolveChineseName(string typeId, string localizedName)
        {
            if (!string.IsNullOrWhiteSpace(localizedName)) return localizedName;
            return ChineseNameFallbacks.TryGetValue(typeId ?? string.Empty, out var fallback)
                ? fallback
                : $"未本地化 · {Humanize(typeId)}";
        }

        private static object GetSingleton(string typeName)
        {
            var type = FindType(typeName);
            return type?.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy)?.GetValue(null);
        }

        private static Type FindType(string fullName)
        {
            return Type.GetType($"{fullName}, {GameAssembly}") ?? AppDomain.CurrentDomain.GetAssemblies().Select(assembly => assembly.GetType(fullName, false)).FirstOrDefault(type => type != null);
        }

        private static object Invoke(object target, string methodName, params object[] arguments)
        {
            if (target == null) return null;
            var methods = target.GetType().GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                .Where(method => method.Name == methodName && !method.IsGenericMethodDefinition && method.GetParameters().Length == arguments.Length);
            var method = methods.FirstOrDefault(candidate => candidate.GetParameters().Select(parameter => parameter.ParameterType).Zip(arguments, (type, argument) => argument == null || type.IsInstanceOfType(argument)).All(matches => matches));
            return method?.Invoke(target, arguments);
        }

        private static object InvokeStatic(string typeName, string methodName, params object[] arguments)
        {
            var type = FindType(typeName);
            if (type == null) return null;
            var method = type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
                .FirstOrDefault(candidate => candidate.Name == methodName && candidate.GetParameters().Length == arguments.Length);
            return method?.Invoke(null, arguments);
        }

        private static IEnumerable<object> Enumerate(object value)
        {
            if (value is not IEnumerable enumerable) yield break;
            foreach (var item in enumerable) yield return item;
        }

        private static T ReadMember<T>(object target, string name)
        {
            if (target == null) return default;
            var type = target.GetType();
            var property = type.GetProperty(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            var value = property != null ? property.GetValue(target) : type.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(target);
            if (value is T typed) return typed;
            return default;
        }

        private sealed class CardDto
        {
            public string typeId;
            public string name;
            public string description;
            public string category;
            public int cost;
            public string rarity;
            public string[] tags;
            public string imageUrl;
            public int frameVariant;
        }

        private sealed class RegistryEntryDto
        {
            public string typeId;
            public string name;
            public string description;
        }
    }
}
