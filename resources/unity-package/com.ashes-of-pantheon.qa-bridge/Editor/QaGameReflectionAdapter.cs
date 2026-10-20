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
                equipment = GetEquipmentCatalogEntries(),
                enemies = GetEnemyCatalogEntries(),
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
                movement = MovementAvailability(),
                routePreview = GetRoutePreview(),
                entities = enemyDtos.Concat(GetEquipmentEntities()).ToList()
            };
        }

        public object GetRoutePreviewSnapshot()
        {
            return GetRoutePreview();
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
            var armorValue = request["shield"] == null
                ? null
                : ReadMember<object>(GetBehaviorComponent(player, "HappyHotel.Core.ValueProcessing.Components.ArmorValueComponent"), "ArmorValue");
            var attack = request["baseAttack"] == null
                ? null
                : GetBehaviorComponent(player, "HappyHotel.Core.ValueProcessing.Components.AttackPowerComponent");
            var money = request["gold"] == null ? null : GetSingleton("HappyHotel.Shop.ShopMoneyManager");
            if (hp == null || cost == null) return Failure("Player value modules are unavailable.");
            if (request["shield"] != null && armorValue == null) return Failure("Player armor module is unavailable.");
            if (request["baseAttack"] != null && attack == null) return Failure("Player attack module is unavailable.");
            if (request["gold"] != null && money == null) return Failure("Player money module is unavailable.");

            Invoke(hp, "SetHitPoint", request.Value<int>("maxHp"), request.Value<int>("currentHp"));
            Invoke(cost, "SetCost", request.Value<int>("currentCost"), request.Value<int>("maxCost"), true);
            if (request["shield"] != null)
            {
                Invoke(armorValue, "SetCurrentValue", request.Value<int>("shield"));
            }
            if (request["baseAttack"] != null)
            {
                Invoke(attack, "SetAttackPower", request.Value<int>("baseAttack"));
            }
            if (request["gold"] != null)
            {
                Invoke(money, "SetCurrentMoney", request.Value<int>("gold"));
            }
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
            Invoke(attack, "SetAttackPower", request["baseAttack"] != null ? request.Value<int>("baseAttack") : request.Value<int>("attack"));
            return Success("Enemy values updated.");
        }

        public object RemoveEquipment(JObject request)
        {
            var targetId = request.Value<string>("moveTargetId");
            var prop = GetEquipmentObjects().FirstOrDefault(item => MoveTargetId(item) == targetId);
            if (prop == null) return Failure("Equipment instance is unavailable.");
            var controller = GetSingleton("HappyHotel.Prop.PropController");
            var reasonType = FindType("HappyHotel.Prop.PropRemovalReason");
            if (controller == null || reasonType == null) return Failure("Equipment removal module is unavailable.");
            var card = Invoke(prop, "GetSourceEquipment");
            var deployment = GetSingleton("HappyHotel.Inventory.EquipmentCardDeploymentService");
            var temporary = card != null && Invoke(deployment, "IsTemporary", card) is bool value && value;
            if (!(Invoke(controller, "RemoveProp", prop, Enum.Parse(reasonType, "RunReset")) is bool removed) || !removed)
                return Failure("Equipment removal failed.");
            if (card != null && !temporary) ReleaseCardInstance(GetSingleton("HappyHotel.Card.CardManager"), card);
            return Success("Equipment removed.");
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

        public object UpdateBuff(JObject request)
        {
            var target = FindTarget(request.Value<string>("targetInstanceId"));
            var container = GetBehaviorComponent(target, "HappyHotel.Buff.Components.BuffContainer");
            if (container == null) return Failure("BUFF target is unavailable.");
            var buffs = Enumerate(Invoke(container, "GetAllBuffs")).ToList();
            var index = ParseIndexedInstance(request.Value<string>("instanceId"), "buff-");
            if (index < 0 || index >= buffs.Count) return Failure("BUFF instance is unavailable.");
            var buff = buffs[index];
            var expectedTypeId = request.Value<string>("typeId");
            if (!string.IsNullOrWhiteSpace(expectedTypeId) && !string.Equals(ResolveTypeId(buff), expectedTypeId, StringComparison.Ordinal))
                return Failure("BUFF list changed; refresh and retry.");
            Invoke(buff, "SetStacks", Math.Max(0, request.Value<int>("stacks")));
            return Success("BUFF stacks updated.");
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
            var groupType = executorType.GetNestedType("IntentGroupPlan", BindingFlags.Public);
            if (groupType == null) return Failure("Intent group module is unavailable.");
            var planListType = typeof(List<>).MakeGenericType(planType);
            var groupListType = typeof(List<>).MakeGenericType(groupType);
            var groups = (IList)Activator.CreateInstance(groupListType);
            var steps = request["steps"] as JArray ?? new JArray();
            foreach (var stepGroup in steps.Select((step, index) => new { step, index })
                         .GroupBy(item => item.step.Value<int?>("groupIndex") ?? item.index))
            {
                var plans = (IList)Activator.CreateInstance(planListType);
                foreach (var item in stepGroup)
                {
                    var step = item.step;
                    var typeIdText = step.Value<string>("typeId");
                    var typeId = Invoke(registry, "GetType", typeIdText);
                    if (typeId == null) return Failure($"Intent TypeId is not registered: {typeIdText}");
                    var plan = Activator.CreateInstance(planType);
                    WriteMember(plan, "TypeId", typeId);
                    WriteMember(plan, "Setting", CreateSetting(registry, typeId, step["parameters"] as JObject));
                    WriteMember(plan, "ProjectileClassId", step.Value<string>("projectileClassId") ?? string.Empty);
                    plans.Add(plan);
                }
                var group = Activator.CreateInstance(groupType);
                WriteMember(group, "Intents", plans);
                groups.Add(group);
            }

            var method = executor.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(candidate => candidate.Name == "SetGroupSequenceWithLoopStart" && candidate.GetParameters().Length == 2);
            if (method == null) return Failure("Intent sequence setter is unavailable.");
            method.Invoke(executor, new object[] { groups, request.Value<int>("loopStartIndex") });
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


        private IEnumerable<object> GetEquipmentObjects()
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
                yield return prop;
            }
        }

        private IEnumerable<object> GetEquipmentEntities()
        {
            foreach (var prop in GetEquipmentObjects())
            {
                var card = Invoke(prop, "GetSourceEquipment");
                var typeId = ResolveTypeId(card ?? prop);
                var definition = ResolveRegistryEntry("HappyHotel.Card.CardRegistry", typeId, "itemNameLocalized");
                var point = GetGridPosition(prop);
                var id = prop is UnityEngine.Object obj ? obj.GetInstanceID().ToString() : System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(prop).ToString();
                yield return new {
                    instanceId = $"equipment#{id}", moveTargetId = MoveTargetId(prop), size = GridSize(prop), typeId, definition.name, kind = "equipment",
                    position = new { x = point.x, y = point.y }, buffs = Array.Empty<object>()
                };
            }
        }


        private static string MoveTargetId(object target)
        {
            return target is UnityEngine.Object obj && obj != null ? obj.GetInstanceID().ToString() : null;
        }

        private static object GridSize(object target)
        {
            var grid = GetBehaviorComponent(target, "HappyHotel.Core.Grid.Components.GridObjectComponent");
            var size = Invoke(grid, "GetSize") is Vector2Int value ? value : new Vector2Int(1, 1);
            return new { x = size.x, y = size.y };
        }

        private static string MovementBlockReason()
        {
            if (!UnityEditor.EditorApplication.isPlaying) return "请先进入 Play Mode。";
            var game = GetSingleton("HappyHotel.GameManager.GameManager");
            var turn = GetSingleton("HappyHotel.GameManager.TurnManager");
            if (Invoke(game, "GetGameState")?.ToString() != "Idle" ||
                Invoke(turn, "GetCurrentPhase")?.ToString() != "Player" || ReadMember<bool>(turn, "IsAdvancingTurn"))
                return "请等待玩家可操作的空闲阶段。";
            var blocks = GetSingleton("HappyHotel.GameManager.BattleFlowBlockService");
            var settling = FindType("HappyHotel.GameManager.BattleActionSettlementService")
                ?.GetProperty("HasActivePlayerActions", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);
            if (ReadMember<bool>(blocks, "IsInputBlocked") || ReadMember<bool>(blocks, "IsFlowBlocked") || settling is true)
                return "战斗正在结算，暂时不能移动对象。";
            return null;
        }

        private static object MovementAvailability()
        {
            var reason = MovementBlockReason();
            return new { allowed = reason == null, reason = reason ?? string.Empty };
        }

        public object MoveEntity(JObject request)
        {
            if (request?["expiresAt"] != null && request.Value<long>("expiresAt") < DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
                return Failure("移动请求已过期，请重新拖动。");
            var blocked = MovementBlockReason();
            if (blocked != null) return Failure(blocked);
            if (!TryReadPoint(request?["from"], out var from) || !TryReadPoint(request?["to"], out var to))
                return Failure("移动坐标必须是整数。");
            var targetId = request.Value<string>("moveTargetId");
            if (string.IsNullOrWhiteSpace(targetId)) return Failure("缺少对象的运行实例标识，请更新 Bridge 并刷新。");
            var player = GetControllerObjects("HappyHotel.Character.CharacterController", "GetAllCharacters").FirstOrDefault(IsMainCharacter);
            var candidates = new[] { player }.Concat(GetControllerObjects("HappyHotel.Enemy.EnemyController", "GetAllEnemies")).Concat(GetEquipmentObjects());
            var target = candidates.FirstOrDefault(item => MoveTargetId(item) == targetId);
            if (target == null) return Failure("对象已消失，请刷新后重试。");
            var current = GetGridPosition(target);
            if (current.x != from.x || current.y != from.y) return Failure("对象位置已变化，请重新拖动。");
            if (from.x == to.x && from.y == to.y) return Success("对象位置未改变。");
            var grid = GetBehaviorComponent(target, "HappyHotel.Core.Grid.Components.GridObjectComponent");
            var manager = GetSingleton("HappyHotel.Core.Grid.GridObjectManager");
            var map = GetSingleton("HappyHotel.Map.LevelMapManager");
            if (grid == null || manager == null || map == null) return Failure("游戏地图尚未初始化。");
            if (!Enumerate(Invoke(manager, "GetObjectsAt", current)).Any(other => ReferenceEquals(other, target)))
                return Failure("对象当前未在战场占格，不能移动。");
            var occupied = Enumerate(Invoke(grid, "GetOccupiedCells", to)).OfType<Vector2Int>().ToList();
            if (occupied.Count == 0) return Failure("对象占格信息不可用。");
            foreach (var point in occupied)
            {
                if (!(Invoke(map, "IsWalkable", point.x, point.y) is bool walkable) || !walkable)
                    return Failure("目标位置超出地图或不可通行。");
                if (Enumerate(Invoke(manager, "GetObjectsAt", point)).Any(other => !ReferenceEquals(other, target)))
                    return Failure("目标格已被占用。");
                if (IsInstanceOf(target, "HappyHotel.Prop.EquipmentPropBase") &&
                    Invoke(manager, "HasEquipmentSpawnBlockerAt", point, target) is bool reserved && reserved)
                    return Failure("该格禁止放置装备。");
            }
            var autoMove = GetBehaviorComponent(target, "HappyHotel.Core.Grid.Components.AutoMoveComponent");
            if (ReadMember<bool>(autoMove, "IsVisualInterpolating")) return Failure("对象正在移动，请稍后重试。");
            if (ReferenceEquals(target, player))
            {
                var relocation = GetBehaviorComponent(player, "HappyHotel.Character.Components.MainCharacterRelocationComponent");
                if (relocation == null || ReadMember<bool>(relocation, "IsMovementGateHeld"))
                    return Failure("主角迁移不可用或仍在结算，请稍后重试。");
                var requestType = relocation.GetType().GetNestedType("RelocationRequest", BindingFlags.Public);
                var begin = relocation.GetType().GetMethod("TryBeginRelocation", BindingFlags.Public | BindingFlags.Instance);
                var settle = relocation.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                    .FirstOrDefault(method => method.Name == "SettleImmediately" && method.GetParameters().Length == 2);
                if (requestType == null || begin == null || settle == null) return Failure("当前游戏不支持主角迁移。");
                var move = Activator.CreateInstance(requestType);
                WriteMember(move, "Destination", to);
                WriteMember(move, "ConsumedMovementCells", 0);
                WriteMember(move, "PreserveStraightMovement", false);
                WriteMember(move, "Source", "QA.ObjectMove");
                var arguments = new[] { move, null };
                if (!(begin.Invoke(relocation, arguments) is bool begun) || !begun) return Failure("游戏拒绝了主角迁移。");
                var handle = arguments[1];
                try
                {
                    var result = Invoke(relocation, "SettleImmediately", handle, "QA.ObjectMove");
                    if (!ReadMember<bool>(result, "Succeeded")) return Failure("主角移动结算失败，请刷新实际位置。");
                }
                finally
                {
                    if (ReadMember<bool>(handle, "IsPending")) Invoke(relocation, "SettleImmediately", handle, "QA.ObjectMoveCleanup");
                }
            }
            else if (!(Invoke(manager, "MoveObject", target, to, null) is bool moved) || !moved)
                return Failure("游戏拒绝了移动，请刷新实际位置。");
            Invoke(GetSingleton("HappyHotel.Prop.RoutePreview.RoutePreviewManager"), "RequestRefresh", "QA.ObjectMove", target);
            current = GetGridPosition(target);
            return current.x == to.x && current.y == to.y ? Success($"对象已移动到 {to.x}, {to.y}。") : Failure("移动后的位置与目标不一致，请刷新。");
        }

        private static bool TryReadPoint(JToken token, out Vector2Int point)
        {
            point = default;
            if (token is not JObject value || value["x"]?.Type != JTokenType.Integer || value["y"]?.Type != JTokenType.Integer) return false;
            var x = value.Value<long>("x");
            var y = value.Value<long>("y");
            if (x < int.MinValue || x > int.MaxValue || y < int.MinValue || y > int.MaxValue) return false;
            point = new Vector2Int((int)x, (int)y);
            return true;
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
            var armor = GetBehaviorComponent(player, "HappyHotel.Core.ValueProcessing.Components.ArmorValueComponent");
            var attack = GetBehaviorComponent(player, "HappyHotel.Core.ValueProcessing.Components.AttackPowerComponent");
            var money = GetSingleton("HappyHotel.Shop.ShopMoneyManager");
            var position = GetGridPosition(player);
            return new
            {
                instanceId = "player-main",
                moveTargetId = MoveTargetId(player),
                size = GridSize(player),
                name = ReadMember<string>(player, "CharacterId") ?? "Main Character",
                position = new { x = position.x, y = position.y },
                currentHp = ReadMember<int>(hp, "CurrentHitPoint"),
                maxHp = ReadMember<int>(hp, "MaxHitPoint"),
                currentCost = ReadMember<int>(costManager, "CurrentCost"),
                maxCost = ReadMember<int>(costManager, "MaxCost"),
                shield = ReadMember<int>(armor, "CurrentArmor"),
                baseAttack = ReadBaseAttack(attack),
                attack = ReadMember<int>(attack, "AttackPower"),
                gold = ReadMember<int>(money, "CurrentMoney"),
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
                moveTargetId = MoveTargetId(target),
                size = GridSize(target),
                typeId,
                name = Humanize(typeId),
                kind,
                position = new { x = position.x, y = position.y },
                currentHp = ReadMember<int>(hp, "CurrentHitPoint"),
                maxHp = ReadMember<int>(hp, "MaxHitPoint"),
                baseAttack = ReadBaseAttack(attack),
                attack = ReadMember<int>(attack, "AttackPower"),
                buffs = GetBuffs(target),
                intents = GetIntents(executor),
                loopStartIndex = executor == null ? -1 : Convert.ToInt32(Invoke(executor, "GetLoopStartIndex"))
            };
        }

        private object[] GetIntents(object executor)
        {
            if (executor == null) return Array.Empty<object>();
            var result = new List<object>();
            var itemIndex = 0;
            foreach (var group in Enumerate(Invoke(executor, "GetGroupSequence")).Select((value, index) => new { value, index }))
            {
                foreach (var plan in Enumerate(ReadMember<object>(group.value, "Intents")))
                {
                    var rawTypeId = ReadMember<object>(plan, "TypeId");
                    var typeId = ReadMember<string>(rawTypeId, "Id") ?? rawTypeId?.ToString() ?? "Unknown";
                    var definition = ResolveRegistryEntry("HappyHotel.Intent.IntentRegistry", typeId, "intentNameLocalized");
                    result.Add(new
                    {
                        instanceId = $"intent-{itemIndex++}",
                        typeId,
                        name = definition.name,
                        summary = definition.description,
                        parameters = ReadSettingParameters(ReadMember<object>(plan, "Setting")),
                        groupIndex = group.index,
                        projectileClassId = ReadMember<string>(plan, "ProjectileClassId") ?? string.Empty
                    });
                }
            }
            return result.ToArray();
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
                    stacks = ReadBuffStacks(buff),
                    definition.description
                };
            }).Cast<object>().ToArray();
        }

        private static int ReadBuffStacks(object buff)
        {
            return Invoke(buff, "GetStacks") is int count ? count : 1;
        }

        private static int ReadBaseAttack(object attack)
        {
            return ReadMember<int>(ReadMember<object>(attack, "runAttackValue"), "CurrentValue");
        }

        private static Dictionary<string, object> ReadSettingParameters(object setting)
        {
            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            if (setting == null) return result;
            foreach (var property in setting.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(item => item.CanRead && item.GetIndexParameters().Length == 0))
            {
                var value = property.GetValue(setting);
                if (IsEditableSettingValue(value)) result[property.Name] = NormalizeSettingValue(value);
            }
            foreach (var field in setting.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance))
            {
                var value = field.GetValue(setting);
                if (IsEditableSettingValue(value)) result[field.Name] = NormalizeSettingValue(value);
            }
            return result;
        }

        private static bool IsEditableSettingValue(object value)
        {
            return value != null && (value is string || value is bool || value is byte || value is short || value is int || value is long || value is float || value is double || value.GetType().IsEnum);
        }

        private static object NormalizeSettingValue(object value)
        {
            return value.GetType().IsEnum ? value.ToString() : value;
        }

        private static object GetRoutePreview()
        {
            var manager = GetSingleton("HappyHotel.Prop.RoutePreview.RoutePreviewManager");
            var result = ReadMember<object>(manager, "LatestResult") ?? ReadMember<object>(manager, "ActiveMovementPresentationRoute");
            if (result == null) return null;
            var start = ReadMember<Vector2Int>(result, "StartPosition");
            var terminal = ReadMember<Vector2Int>(result, "TerminalPosition");
            return new
            {
                startPosition = new { x = start.x, y = start.y },
                steps = Enumerate(ReadMember<object>(result, "Steps")).Select(step =>
                {
                    var point = ReadMember<Vector2Int>(step, "Position");
                    return new { x = point.x, y = point.y };
                }).ToArray(),
                hasLoop = ReadMember<bool>(result, "HasLoop"),
                hasTerminalPosition = ReadMember<bool>(result, "HasTerminalPosition"),
                terminalPosition = new { x = terminal.x, y = terminal.y },
                stopReason = ReadMember<object>(result, "StopReason")?.ToString() ?? string.Empty
            };
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

        // ---- Catalog icon export (equipment sprites + Spine composed enemy portraits) ----
        private const int EquipmentIconMaxEdge = 128;
        private const int EnemyIconMaxEdge = 128;
        private const float DegreesToRadians = 0.0174532924f;
        private static readonly Dictionary<string, string> IconCache = new Dictionary<string, string>(StringComparer.Ordinal);
        private static readonly Dictionary<object, string> SkeletonIconCache = new Dictionary<object, string>();
        private static readonly Dictionary<Texture2D, Color32[]> TexturePixelCache = new Dictionary<Texture2D, Color32[]>();

        private struct IconMatrix
        {
            public float a;
            public float b;
            public float c;
            public float d;
            public float tx;
            public float ty;
        }

        private struct IconBoneDefinition
        {
            public string parent;
            public float x;
            public float y;
            public float rotation;
            public float scaleX;
            public float scaleY;
        }

        private sealed class IconRegionMap
        {
            public float u;
            public float u2;
            public float v;
            public float v2;
            public bool vFromBottom;
            public bool valid;

            public float SampleU(float localU)
            {
                return u + localU * (u2 - u);
            }

            public float SampleV(float localV)
            {
                if (vFromBottom) return v + localV * (v2 - v);
                return 1f - (v + (1f - localV) * (v2 - v));
            }
        }

        private sealed class IconTriangle
        {
            public float ax;
            public float ay;
            public float bx;
            public float by;
            public float cx;
            public float cy;
            public float au;
            public float av;
            public float bu;
            public float bv;
            public float cu;
            public float cv;
            public int page;
        }

        private sealed class EquipmentDto
        {
            public string typeId;
            public string name;
            public string iconUrl;
        }

        private sealed class EnemyDto
        {
            public string typeId;
            public string name;
            public string iconUrl;
        }

        private List<EquipmentDto> GetEquipmentCatalogEntries()
        {
            var entries = new List<EquipmentDto>();
            try
            {
                var registry = GetSingleton("HappyHotel.Card.CardRegistry");
                if (registry == null) return entries;
                Invoke(registry, "Initialize");
                foreach (var entry in Enumerate(Invoke(registry, "GetAllIndexEntries")))
                {
                    var typeId = ReadMember<string>(entry, "TypeId");
                    if (string.IsNullOrWhiteSpace(typeId)) continue;
                    var template = ReadMember<object>(entry, "TemplateObject") ?? ReadMember<object>(entry, "template");
                    if (!string.Equals(ResolveCardCategory(template), "equipment", StringComparison.Ordinal)) continue;
                    var name = ResolveTemplateText(template, "itemNameLocalized", "ItemNames", "Name", typeId);
                    entries.Add(new EquipmentDto
                    {
                        typeId = typeId,
                        name = ResolveChineseName(typeId, name),
                        iconUrl = GetTemplateIcon(template, typeId)
                    });
                }
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.LogWarning($"[AshesOfPantheonQA] Equipment catalog failed: {exception.Message}");
            }

            return entries.OrderBy(entry => entry.typeId, StringComparer.Ordinal).ToList();
        }

        private static string GetTemplateIcon(object template, string typeId)
        {
            if (template == null) return null;
            var cacheKey = "equipment:" + typeId;
            if (IconCache.TryGetValue(cacheKey, out var cached)) return cached;
            string icon = null;
            try
            {
                var sprite = ReadMember<Sprite>(template, "cardImage")
                    ?? ReadMember<Sprite>(template, "icon")
                    ?? ReadMember<Sprite>(template, "itemIcon");
                if (sprite != null && sprite.texture != null) icon = EncodeSpriteAtEdge(sprite, EquipmentIconMaxEdge);
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.LogWarning($"[AshesOfPantheonQA] Equipment icon {typeId} failed: {exception.Message}");
            }

            if (!string.IsNullOrEmpty(icon)) IconCache[cacheKey] = icon;
            return icon;
        }

        private static string EncodeSpriteAtEdge(Sprite sprite, int maxEdge)
        {
            if (sprite == null || sprite.texture == null) return null;
            var rect = sprite.rect;
            if (rect.width <= 0f || rect.height <= 0f) return null;
            var scale = Mathf.Min(1f, maxEdge / Mathf.Max(rect.width, rect.height));
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
                UnityEngine.Debug.LogWarning($"[AshesOfPantheonQA] Sprite icon export failed for {sprite.name}: {exception.Message}");
                return null;
            }
            finally
            {
                if (output != null) UnityEngine.Object.DestroyImmediate(output);
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(renderTexture);
            }
        }

        private List<EnemyDto> GetEnemyCatalogEntries()
        {
            var entries = new List<EnemyDto>();
            try
            {
                var registry = GetSingleton("HappyHotel.Enemy.EnemyRegistry");
                if (registry == null) return entries;
                Invoke(registry, "Initialize");
                foreach (var entry in Enumerate(Invoke(registry, "GetAllIndexEntries")))
                {
                    var typeId = ReadMember<string>(entry, "TypeId");
                    if (string.IsNullOrWhiteSpace(typeId)) continue;
                    var template = ReadMember<object>(entry, "TemplateObject") ?? ReadMember<object>(entry, "template");
                    entries.Add(new EnemyDto
                    {
                        typeId = typeId,
                        name = ResolveChineseName(typeId, ReadMember<string>(template, "enemyName")),
                        iconUrl = GetEnemyIcon(template, typeId)
                    });
                }
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.LogWarning($"[AshesOfPantheonQA] Enemy catalog failed: {exception.Message}");
            }

            return entries.OrderBy(entry => entry.typeId, StringComparer.Ordinal).ToList();
        }

        private static string GetEnemyIcon(object template, string typeId)
        {
            if (template == null) return null;
            var cacheKey = "enemy:" + typeId;
            if (IconCache.TryGetValue(cacheKey, out var cached)) return cached;
            string icon = null;
            try
            {
                var skeletonDataAsset = FindEnemySkeletonDataAsset(template);
                if (skeletonDataAsset != null && !SkeletonIconCache.TryGetValue(skeletonDataAsset, out icon))
                {
                    icon = ComposeSpineIcon(skeletonDataAsset);
                    if (!string.IsNullOrEmpty(icon)) SkeletonIconCache[skeletonDataAsset] = icon;
                }
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.LogWarning($"[AshesOfPantheonQA] Enemy icon {typeId} failed: {exception.Message}");
            }

            if (!string.IsNullOrEmpty(icon)) IconCache[cacheKey] = icon;
            return icon;
        }

        private static object FindEnemySkeletonDataAsset(object template)
        {
            var prefab = ReadMember<GameObject>(template, "prefab");
            if (prefab != null)
            {
                var rendererType = FindType("Spine.Unity.SkeletonRenderer");
                if (rendererType != null)
                {
                    foreach (var component in prefab.GetComponentsInChildren(rendererType, true))
                    {
                        var asset = ReadMember<object>(component, "skeletonDataAsset");
                        if (HasSkeletonJson(asset)) return asset;
                    }
                }

                var controllerType = FindType("SpineUtil.SpineAnimationController");
                if (controllerType != null)
                {
                    foreach (var component in prefab.GetComponentsInChildren(controllerType, true))
                    {
                        var animation = ReadMember<object>(component, "skeletonAnimation") ?? ReadMember<object>(component, "m_skeletonAnimation");
                        var graphic = ReadMember<object>(component, "skeletonGraphic") ?? ReadMember<object>(component, "m_skeletonGraphic");
                        var asset = ReadMember<object>(animation, "skeletonDataAsset") ?? ReadMember<object>(graphic, "skeletonDataAsset");
                        if (HasSkeletonJson(asset)) return asset;
                    }
                }
            }

            foreach (var fieldName in new[] { "resurgenceDown", "resurgenceUp", "resurgenceSide", "defaultSkeletonData" })
            {
                var asset = ReadMember<object>(template, fieldName);
                if (HasSkeletonJson(asset)) return asset;
            }

            return null;
        }

        private static bool HasSkeletonJson(object skeletonDataAsset)
        {
            var skeletonJson = ReadMember<TextAsset>(skeletonDataAsset, "skeletonJSON");
            return skeletonJson != null && !string.IsNullOrEmpty(skeletonJson.text);
        }

        private static string ComposeSpineIcon(object skeletonDataAsset)
        {
            var skeletonJson = ReadMember<TextAsset>(skeletonDataAsset, "skeletonJSON")?.text;
            if (string.IsNullOrWhiteSpace(skeletonJson)) return null;
            var atlas = GetComposeAtlas(skeletonDataAsset, out var pages, out var textures);
            if (atlas == null || textures.Count == 0) return null;
            JObject skeleton;
            try
            {
                skeleton = JObject.Parse(skeletonJson);
            }
            catch (Exception)
            {
                return null;
            }

            var boneTokens = skeleton["bones"] as JArray;
            var slotTokens = skeleton["slots"] as JArray;
            var attachmentsRoot = ((skeleton["skins"] as JArray)?.OfType<JObject>().FirstOrDefault())?["attachments"] as JObject;
            if (boneTokens == null || slotTokens == null || attachmentsRoot == null) return null;

            var boneDefinitions = new Dictionary<string, IconBoneDefinition>(StringComparer.Ordinal);
            var boneOrder = new List<string>();
            foreach (var token in boneTokens.OfType<JObject>())
            {
                var name = token["name"]?.ToString();
                if (string.IsNullOrEmpty(name) || boneDefinitions.ContainsKey(name)) continue;
                boneOrder.Add(name);
                boneDefinitions[name] = new IconBoneDefinition
                {
                    parent = token["parent"]?.ToString(),
                    x = ReadJsonFloat(token["x"]),
                    y = ReadJsonFloat(token["y"]),
                    rotation = ReadJsonFloat(token["rotation"]),
                    scaleX = ReadJsonFloat(token["scaleX"], 1f),
                    scaleY = ReadJsonFloat(token["scaleY"], 1f)
                };
            }

            var boneMatrices = new Dictionary<string, IconMatrix>(StringComparer.Ordinal);
            Func<string, IconMatrix> resolveBone = null;
            resolveBone = name =>
            {
                if (string.IsNullOrEmpty(name)) return IdentityMatrix();
                if (boneMatrices.TryGetValue(name, out var cached)) return cached;
                if (!boneDefinitions.TryGetValue(name, out var definition)) return IdentityMatrix();
                var local = MakeBoneMatrix(definition);
                var world = string.IsNullOrEmpty(definition.parent) ? local : MultiplyMatrix(resolveBone(definition.parent), local);
                boneMatrices[name] = world;
                return world;
            };

            var regions = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var region in Enumerate(ReadMember<object>(atlas, "regions")))
            {
                var regionName = ReadMember<string>(region, "name");
                if (!string.IsNullOrEmpty(regionName) && !regions.ContainsKey(regionName)) regions[regionName] = region;
            }

            var pageSlots = new Dictionary<object, int>();
            for (var index = 0; index < pages.Count; index++) pageSlots[pages[index]] = index;

            var triangles = new List<IconTriangle>();
            foreach (var slotToken in slotTokens.OfType<JObject>())
            {
                var slotName = slotToken["name"]?.ToString();
                var slotBoneName = slotToken["bone"]?.ToString();
                if (string.IsNullOrEmpty(slotName)) continue;
                var slotAttachments = attachmentsRoot[slotName] as JObject;
                if (slotAttachments == null || !slotAttachments.HasValues) continue;
                var attachmentTokenName = slotToken["attachment"]?.ToString();
                if (string.IsNullOrEmpty(attachmentTokenName)) attachmentTokenName = slotAttachments.Properties().First().Name;
                var attachment = slotAttachments[attachmentTokenName] as JObject;
                if (attachment == null) continue;
                var type = attachment["type"]?.ToString() ?? "region";
                if (string.Equals(type, "clipping", StringComparison.Ordinal)) continue;
                var regionName = attachment["path"]?.ToString();
                if (string.IsNullOrEmpty(regionName)) regionName = attachmentTokenName;
                if (!regions.TryGetValue(regionName, out var region)) continue;
                if (ReadMember<bool>(region, "rotate") || ReadMember<int>(region, "degrees") != 0) continue;
                var pageSlot = 0;
                var pageObject = ReadMember<object>(region, "page");
                if (pageObject != null && pageSlots.TryGetValue(pageObject, out var resolvedPageSlot)) pageSlot = resolvedPageSlot;
                if (pageSlot >= textures.Count || textures[pageSlot] == null) continue;
                var regionMap = MakeRegionMap(region, textures[pageSlot]);
                if (!regionMap.valid) continue;
                if (string.Equals(type, "mesh", StringComparison.Ordinal))
                {
                    AddMeshTriangles(attachment, slotBoneName, boneOrder, pageSlot, regionMap, resolveBone, triangles);
                }
                else
                {
                    AddRegionTriangles(attachment, slotBoneName, pageSlot, regionMap, resolveBone, triangles);
                }
            }

            if (triangles.Count == 0) return null;
            return RasterizeIcon(triangles, textures);
        }

        private static object GetComposeAtlas(object skeletonDataAsset, out List<object> pages, out List<Texture2D> textures)
        {
            pages = new List<object>();
            textures = new List<Texture2D>();
            foreach (var atlasAsset in Enumerate(ReadMember<object>(skeletonDataAsset, "atlasAssets")))
            {
                if (atlasAsset == null) continue;
                object atlas = null;
                try
                {
                    atlas = Invoke(atlasAsset, "GetAtlas", false);
                }
                catch (Exception)
                {
                    atlas = null;
                }

                if (atlas == null) continue;
                pages.Clear();
                textures.Clear();
                foreach (var page in Enumerate(ReadMember<object>(atlas, "pages")))
                {
                    pages.Add(page);
                    textures.Add(ReadPageTexture(page));
                }

                if (textures.Exists(texture => texture != null)) return atlas;
            }

            return null;
        }

        private static Texture2D ReadPageTexture(object page)
        {
            var rendererObject = ReadMember<object>(page, "rendererObject");
            var material = rendererObject as Material;
            if (material == null) return rendererObject as Texture2D;
            return material.mainTexture as Texture2D;
        }

        private static IconRegionMap MakeRegionMap(object region, Texture2D texture)
        {
            var map = new IconRegionMap
            {
                u = ReadMember<float>(region, "u"),
                u2 = ReadMember<float>(region, "u2"),
                v = ReadMember<float>(region, "v"),
                v2 = ReadMember<float>(region, "v2")
            };
            if (texture == null) return map;
            var textureHeight = texture.height;
            var regionY = ReadMember<int>(region, "y");
            var regionHeight = ReadMember<int>(region, "height");
            if (regionHeight <= 0) return map;
            var vAtZero = map.v * textureHeight;
            var flippedError = Mathf.Abs(vAtZero - (textureHeight - regionY - regionHeight));
            var straightError = Mathf.Abs(vAtZero - regionY);
            map.vFromBottom = flippedError <= straightError;
            map.valid = Mathf.Abs(map.u2 - map.u) > 0.00001f && Mathf.Abs(map.v2 - map.v) > 0.00001f;
            return map;
        }

        private static void AddRegionTriangles(JObject attachment, string boneName, int pageSlot, IconRegionMap regionMap, Func<string, IconMatrix> resolveBone, List<IconTriangle> triangles)
        {
            var width = ReadJsonFloat(attachment["width"]);
            var height = ReadJsonFloat(attachment["height"]);
            if (width <= 0f || height <= 0f) return;
            var scaleX = ReadJsonFloat(attachment["scaleX"], 1f);
            var scaleY = ReadJsonFloat(attachment["scaleY"], 1f);
            var rotation = ReadJsonFloat(attachment["rotation"]) * DegreesToRadians;
            var cos = (float)System.Math.Cos(rotation);
            var sin = (float)System.Math.Sin(rotation);
            var offsetX = ReadJsonFloat(attachment["x"]);
            var offsetY = ReadJsonFloat(attachment["y"]);
            var bone = resolveBone(boneName);
            var left = -width * 0.5f * scaleX;
            var bottom = -height * 0.5f * scaleY;
            var right = left + width * scaleX;
            var top = bottom + height * scaleY;

            TransformIconPoint(left, bottom, cos, sin, offsetX, offsetY, bone, out var bottomLeftX, out var bottomLeftY);
            TransformIconPoint(left, top, cos, sin, offsetX, offsetY, bone, out var topLeftX, out var topLeftY);
            TransformIconPoint(right, top, cos, sin, offsetX, offsetY, bone, out var topRightX, out var topRightY);
            TransformIconPoint(right, bottom, cos, sin, offsetX, offsetY, bone, out var bottomRightX, out var bottomRightY);

            triangles.Add(MakeIconTriangle(bottomLeftX, bottomLeftY, 0f, 0f, topLeftX, topLeftY, 0f, 1f, topRightX, topRightY, 1f, 1f, regionMap, pageSlot));
            triangles.Add(MakeIconTriangle(bottomLeftX, bottomLeftY, 0f, 0f, topRightX, topRightY, 1f, 1f, bottomRightX, bottomRightY, 1f, 0f, regionMap, pageSlot));
        }

        private static void AddMeshTriangles(JObject attachment, string boneName, List<string> boneOrder, int pageSlot, IconRegionMap regionMap, Func<string, IconMatrix> resolveBone, List<IconTriangle> triangles)
        {
            var uvsToken = attachment["uvs"] as JArray;
            var verticesToken = attachment["vertices"] as JArray;
            var indicesToken = attachment["triangles"] as JArray;
            if (uvsToken == null || verticesToken == null || indicesToken == null) return;
            var vertexCount = uvsToken.Count / 2;
            if (vertexCount < 3) return;
            var positionsX = new float[vertexCount];
            var positionsY = new float[vertexCount];
            var valid = false;
            if (verticesToken.Count == vertexCount * 2)
            {
                var bone = resolveBone(boneName);
                for (var index = 0; index < vertexCount; index++)
                {
                    var localX = ReadJsonFloat(verticesToken[index * 2]);
                    var localY = ReadJsonFloat(verticesToken[index * 2 + 1]);
                    positionsX[index] = bone.a * localX + bone.c * localY + bone.tx;
                    positionsY[index] = bone.b * localX + bone.d * localY + bone.ty;
                }

                valid = true;
            }
            else if (verticesToken.Count == vertexCount * 3)
            {
                for (var index = 0; index < vertexCount; index++)
                {
                    var boneIndex = (int)ReadJsonFloat(verticesToken[index * 3]);
                    var bone = resolveBone(boneIndex >= 0 && boneIndex < boneOrder.Count ? boneOrder[boneIndex] : boneName);
                    var localX = ReadJsonFloat(verticesToken[index * 3 + 1]);
                    var localY = ReadJsonFloat(verticesToken[index * 3 + 2]);
                    positionsX[index] = bone.a * localX + bone.c * localY + bone.tx;
                    positionsY[index] = bone.b * localX + bone.d * localY + bone.ty;
                }

                valid = true;
            }
            else
            {
                var position = 0;
                var parsed = true;
                for (var index = 0; index < vertexCount; index++)
                {
                    if (position >= verticesToken.Count)
                    {
                        parsed = false;
                        break;
                    }

                    var boneCount = (int)ReadJsonFloat(verticesToken[position++]);
                    var sumX = 0f;
                    var sumY = 0f;
                    var sumWeight = 0f;
                    for (var boneIndex = 0; boneIndex < boneCount; boneIndex++)
                    {
                        if (position + 3 >= verticesToken.Count)
                        {
                            parsed = false;
                            break;
                        }

                        var boneIndexValue = (int)ReadJsonFloat(verticesToken[position++]);
                        var localX = ReadJsonFloat(verticesToken[position++]);
                        var localY = ReadJsonFloat(verticesToken[position++]);
                        var weight = ReadJsonFloat(verticesToken[position++]);
                        var bone = resolveBone(boneIndexValue >= 0 && boneIndexValue < boneOrder.Count ? boneOrder[boneIndexValue] : boneName);
                        sumX += weight * (bone.a * localX + bone.c * localY + bone.tx);
                        sumY += weight * (bone.b * localX + bone.d * localY + bone.ty);
                        sumWeight += weight;
                    }

                    if (!parsed) break;
                    var divisor = sumWeight > 0.0001f ? sumWeight : 1f;
                    positionsX[index] = sumX / divisor;
                    positionsY[index] = sumY / divisor;
                }

                valid = parsed;
            }

            if (!valid) return;
            for (var index = 0; index + 2 < indicesToken.Count; index += 3)
            {
                var indexA = (int)ReadJsonFloat(indicesToken[index]);
                var indexB = (int)ReadJsonFloat(indicesToken[index + 1]);
                var indexC = (int)ReadJsonFloat(indicesToken[index + 2]);
                if (indexA < 0 || indexB < 0 || indexC < 0) continue;
                if (indexA >= vertexCount || indexB >= vertexCount || indexC >= vertexCount) continue;
                triangles.Add(MakeIconTriangle(
                    positionsX[indexA], positionsY[indexA], ReadJsonFloat(uvsToken[indexA * 2]), ReadJsonFloat(uvsToken[indexA * 2 + 1]),
                    positionsX[indexB], positionsY[indexB], ReadJsonFloat(uvsToken[indexB * 2]), ReadJsonFloat(uvsToken[indexB * 2 + 1]),
                    positionsX[indexC], positionsY[indexC], ReadJsonFloat(uvsToken[indexC * 2]), ReadJsonFloat(uvsToken[indexC * 2 + 1]),
                    regionMap, pageSlot));
            }
        }

        private static void TransformIconPoint(float x, float y, float cos, float sin, float offsetX, float offsetY, IconMatrix bone, out float worldX, out float worldY)
        {
            var rotatedX = cos * x - sin * y + offsetX;
            var rotatedY = sin * x + cos * y + offsetY;
            worldX = bone.a * rotatedX + bone.c * rotatedY + bone.tx;
            worldY = bone.b * rotatedX + bone.d * rotatedY + bone.ty;
        }

        private static IconTriangle MakeIconTriangle(float x0, float y0, float u0, float v0, float x1, float y1, float u1, float v1, float x2, float y2, float u2, float v2, IconRegionMap regionMap, int pageSlot)
        {
            return new IconTriangle
            {
                ax = x0,
                ay = y0,
                au = regionMap.SampleU(u0),
                av = regionMap.SampleV(v0),
                bx = x1,
                by = y1,
                bu = regionMap.SampleU(u1),
                bv = regionMap.SampleV(v1),
                cx = x2,
                cy = y2,
                cu = regionMap.SampleU(u2),
                cv = regionMap.SampleV(v2),
                page = pageSlot
            };
        }

        private static string RasterizeIcon(List<IconTriangle> triangles, List<Texture2D> textures)
        {
            var minX = float.MaxValue;
            var minY = float.MaxValue;
            var maxX = float.MinValue;
            var maxY = float.MinValue;
            foreach (var triangle in triangles)
            {
                minX = Mathf.Min(minX, Mathf.Min(triangle.ax, Mathf.Min(triangle.bx, triangle.cx)));
                maxX = Mathf.Max(maxX, Mathf.Max(triangle.ax, Mathf.Max(triangle.bx, triangle.cx)));
                minY = Mathf.Min(minY, Mathf.Min(triangle.ay, Mathf.Min(triangle.by, triangle.cy)));
                maxY = Mathf.Max(maxY, Mathf.Max(triangle.ay, Mathf.Max(triangle.by, triangle.cy)));
            }

            var worldWidth = maxX - minX;
            var worldHeight = maxY - minY;
            if (worldWidth <= 0.5f || worldHeight <= 0.5f) return null;
            const int supersample = 2;
            var scale = EnemyIconMaxEdge * supersample / Mathf.Max(worldWidth, worldHeight);
            if (scale <= 0f || float.IsInfinity(scale)) return null;
            var pixelWidth = Mathf.Max(1, (int)System.Math.Ceiling(worldWidth * scale));
            var pixelHeight = Mathf.Max(1, (int)System.Math.Ceiling(worldHeight * scale));
            var rgb = new float[pixelWidth * pixelHeight * 3];
            var alpha = new float[pixelWidth * pixelHeight];
            var pixelCache = new Dictionary<int, Color32[]>();
            foreach (var triangle in triangles)
            {
                if (triangle.page < 0 || triangle.page >= textures.Count) continue;
                var texture = textures[triangle.page];
                if (texture == null) continue;
                Color32[] pixels;
                if (!pixelCache.TryGetValue(triangle.page, out pixels))
                {
                    pixels = GetTexturePixels(texture);
                    pixelCache[triangle.page] = pixels;
                }

                if (pixels == null) continue;
                var ax = (triangle.ax - minX) * scale;
                var ay = (maxY - triangle.ay) * scale;
                var bx = (triangle.bx - minX) * scale;
                var by = (maxY - triangle.by) * scale;
                var cx = (triangle.cx - minX) * scale;
                var cy = (maxY - triangle.cy) * scale;
                var denominator = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
                if (Mathf.Abs(denominator) < 0.0001f) continue;
                var minRow = Mathf.Max(0, (int)System.Math.Floor(Mathf.Min(ay, Mathf.Min(by, cy))));
                var maxRow = Mathf.Min(pixelHeight - 1, (int)System.Math.Ceiling(Mathf.Max(ay, Mathf.Max(by, cy))));
                var minColumn = Mathf.Max(0, (int)System.Math.Floor(Mathf.Min(ax, Mathf.Min(bx, cx))));
                var maxColumn = Mathf.Min(pixelWidth - 1, (int)System.Math.Ceiling(Mathf.Max(ax, Mathf.Max(bx, cx))));
                var textureWidth = texture.width;
                var textureHeight = texture.height;
                for (var row = minRow; row <= maxRow; row++)
                {
                    for (var column = minColumn; column <= maxColumn; column++)
                    {
                        var sampleX = column + 0.5f;
                        var sampleY = row + 0.5f;
                        var weightB = ((sampleX - ax) * (cy - ay) - (cx - ax) * (sampleY - ay)) / denominator;
                        var weightC = ((bx - ax) * (sampleY - ay) - (sampleX - ax) * (by - ay)) / denominator;
                        var weightA = 1f - weightB - weightC;
                        if (weightA < -0.0001f || weightB < -0.0001f || weightC < -0.0001f) continue;
                        var sampleU = weightA * triangle.au + weightB * triangle.bu + weightC * triangle.cu;
                        var sampleV = weightA * triangle.av + weightB * triangle.bv + weightC * triangle.cv;
                        var texelX = ClampInt((int)(sampleU * textureWidth), 0, textureWidth - 1);
                        var texelY = ClampInt((int)(sampleV * textureHeight), 0, textureHeight - 1);
                        var source = pixels[texelY * textureWidth + texelX];
                        var sourceAlpha = source.a / 255f;
                        if (sourceAlpha <= 0f) continue;
                        var pixelIndex = row * pixelWidth + column;
                        var destination = pixelIndex * 3;
                        var sourceRed = source.r / 255f * sourceAlpha;
                        var sourceGreen = source.g / 255f * sourceAlpha;
                        var sourceBlue = source.b / 255f * sourceAlpha;
                        var remain = 1f - sourceAlpha;
                        rgb[destination] = sourceRed + rgb[destination] * remain;
                        rgb[destination + 1] = sourceGreen + rgb[destination + 1] * remain;
                        rgb[destination + 2] = sourceBlue + rgb[destination + 2] * remain;
                        alpha[pixelIndex] = sourceAlpha + alpha[pixelIndex] * remain;
                    }
                }
            }

            var finalWidth = Mathf.Max(1, pixelWidth / supersample);
            var finalHeight = Mathf.Max(1, pixelHeight / supersample);
            var colors = new Color32[finalWidth * finalHeight];
            for (var row = 0; row < finalHeight; row++)
            {
                for (var column = 0; column < finalWidth; column++)
                {
                    var sumRed = 0f;
                    var sumGreen = 0f;
                    var sumBlue = 0f;
                    var sumAlpha = 0f;
                    var samples = 0;
                    for (var subRow = 0; subRow < supersample; subRow++)
                    {
                        var sourceRow = row * supersample + subRow;
                        if (sourceRow >= pixelHeight) continue;
                        for (var subColumn = 0; subColumn < supersample; subColumn++)
                        {
                            var sourceColumn = column * supersample + subColumn;
                            if (sourceColumn >= pixelWidth) continue;
                            var index = sourceRow * pixelWidth + sourceColumn;
                            sumRed += rgb[index * 3];
                            sumGreen += rgb[index * 3 + 1];
                            sumBlue += rgb[index * 3 + 2];
                            sumAlpha += alpha[index];
                            samples++;
                        }
                    }

                    if (samples == 0) continue;
                    var averageAlpha = sumAlpha / samples;
                    var color = new Color32();
                    if (averageAlpha > 0.001f)
                    {
                        color.r = ToByte(sumRed / samples / averageAlpha);
                        color.g = ToByte(sumGreen / samples / averageAlpha);
                        color.b = ToByte(sumBlue / samples / averageAlpha);
                        color.a = ToByte(averageAlpha);
                    }

                    colors[(finalHeight - 1 - row) * finalWidth + column] = color;
                }
            }

            Texture2D output = null;
            try
            {
                output = new Texture2D(finalWidth, finalHeight, TextureFormat.RGBA32, false);
                output.SetPixels32(colors);
                output.Apply();
                return $"data:image/png;base64,{Convert.ToBase64String(output.EncodeToPNG())}";
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.LogWarning($"[AshesOfPantheonQA] Enemy icon raster failed: {exception.Message}");
                return null;
            }
            finally
            {
                if (output != null) UnityEngine.Object.DestroyImmediate(output);
            }
        }

        private static Color32[] GetTexturePixels(Texture2D texture)
        {
            if (texture == null) return null;
            if (TexturePixelCache.TryGetValue(texture, out var cached)) return cached;
            Color32[] pixels = null;
            var previous = RenderTexture.active;
            RenderTexture renderTexture = null;
            Texture2D readable = null;
            try
            {
                renderTexture = RenderTexture.GetTemporary(texture.width, texture.height, 0, RenderTextureFormat.ARGB32);
                Graphics.Blit(texture, renderTexture);
                RenderTexture.active = renderTexture;
                readable = new Texture2D(texture.width, texture.height, TextureFormat.RGBA32, false);
                readable.ReadPixels(new Rect(0, 0, texture.width, texture.height), 0, 0);
                readable.Apply();
                pixels = readable.GetPixels32();
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.LogWarning($"[AshesOfPantheonQA] Texture read failed: {exception.Message}");
            }
            finally
            {
                if (readable != null) UnityEngine.Object.DestroyImmediate(readable);
                RenderTexture.active = previous;
                if (renderTexture != null) RenderTexture.ReleaseTemporary(renderTexture);
            }

            if (pixels != null) TexturePixelCache[texture] = pixels;
            return pixels;
        }

        private static IconMatrix IdentityMatrix()
        {
            return new IconMatrix { a = 1f, d = 1f };
        }

        private static IconMatrix MakeBoneMatrix(IconBoneDefinition definition)
        {
            var radians = definition.rotation * DegreesToRadians;
            var cos = (float)System.Math.Cos(radians);
            var sin = (float)System.Math.Sin(radians);
            return new IconMatrix
            {
                a = cos * definition.scaleX,
                b = sin * definition.scaleX,
                c = -sin * definition.scaleY,
                d = cos * definition.scaleY,
                tx = definition.x,
                ty = definition.y
            };
        }

        private static IconMatrix MultiplyMatrix(IconMatrix parent, IconMatrix local)
        {
            return new IconMatrix
            {
                a = parent.a * local.a + parent.c * local.b,
                b = parent.b * local.a + parent.d * local.b,
                c = parent.a * local.c + parent.c * local.d,
                d = parent.b * local.c + parent.d * local.d,
                tx = parent.a * local.tx + parent.c * local.ty + parent.tx,
                ty = parent.b * local.tx + parent.d * local.ty + parent.ty
            };
        }

        private static float ReadJsonFloat(JToken token, float fallback = 0f)
        {
            if (token == null) return fallback;
            try
            {
                return token.Value<float>();
            }
            catch (Exception)
            {
                return fallback;
            }
        }

        private static int ClampInt(int value, int minimum, int maximum)
        {
            if (value < minimum) return minimum;
            return value > maximum ? maximum : value;
        }

        private static byte ToByte(float value)
        {
            return (byte)ClampInt((int)System.Math.Round(value * 255f), 0, 255);
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
