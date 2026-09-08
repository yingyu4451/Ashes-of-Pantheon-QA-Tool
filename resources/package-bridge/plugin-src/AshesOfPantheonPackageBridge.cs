using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using BepInEx;
using BepInEx.Logging;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace AshesOfPantheon.QA.PackageBridge
{
    [BepInPlugin("com.ashes-of-pantheon.qa.package-bridge", "Ashes of Pantheon QA Package Bridge", "0.3.5")]
    public sealed class PackageBridgePlugin : BaseUnityPlugin
    {
        private static QaBridgeServer s_server;

        private void Awake()
        {
            if (s_server != null)
            {
                Logger.LogInfo("Package Bridge is already running.");
                return;
            }

            try
            {
                var unityContext = SynchronizationContext.Current;
                if (unityContext == null) throw new InvalidOperationException("Unity synchronization context is unavailable.");
                s_server = new QaBridgeServer(
                    new QaGameReflectionAdapter(),
                    unityContext,
                    Logger,
                    $"Game Package · {Application.productName}",
                    Application.version,
                    SceneManager.GetActiveScene().name
                );
                s_server.Start();
                Application.quitting += StopServer;
                Logger.LogInfo("Package Bridge started.");
            }
            catch (Exception exception)
            {
                s_server?.Dispose();
                s_server = null;
                Logger.LogError($"Package Bridge startup failed: {exception}");
            }
        }

        private static void StopServer()
        {
            Application.quitting -= StopServer;
            s_server?.Dispose();
            s_server = null;
        }

        private void OnDestroy()
        {
            if (s_server != null) Logger.LogInfo("Package Bridge host was destroyed; the process Bridge remains active.");
        }
    }

    internal sealed class QaBridgeServer : IDisposable
    {
        private readonly QaGameReflectionAdapter m_adapter;
        private readonly SynchronizationContext m_unityContext;
        private readonly ManualLogSource m_logger;
        private readonly string m_displayName;
        private readonly string m_gameVersion;
        private readonly string m_initialSceneName;
        private readonly JsonSerializerSettings m_jsonSettings = new JsonSerializerSettings
        {
            ContractResolver = new CamelCasePropertyNamesContractResolver(),
            NullValueHandling = NullValueHandling.Ignore
        };

        private HttpListener m_listener;
        private Thread m_listenerThread;
        private Timer m_heartbeatTimer;
        private string m_token;
        private string m_instanceId;
        private string m_rendezvousPath;
        private int m_port;
        private volatile bool m_disposed;

        public QaBridgeServer(
            QaGameReflectionAdapter adapter,
            SynchronizationContext unityContext,
            ManualLogSource logger,
            string displayName,
            string gameVersion,
            string initialSceneName)
        {
            m_adapter = adapter;
            m_unityContext = unityContext;
            m_logger = logger;
            m_displayName = displayName;
            m_gameVersion = gameVersion;
            m_initialSceneName = initialSceneName;
        }

        public void Start()
        {
            m_port = ReservePort();
            m_token = CreateToken();
            m_instanceId = $"package-{Process.GetCurrentProcess().Id}";
            m_listener = new HttpListener();
            m_listener.Prefixes.Add($"http://127.0.0.1:{m_port}/");
            m_listener.Start();
            WriteRendezvousFile();
            m_listenerThread = new Thread(ListenLoop) { IsBackground = true, Name = "Ashes QA Package Bridge" };
            m_listenerThread.Start();
            m_heartbeatTimer = new Timer(_ => WriteHeartbeat(), null, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(2));
            UnityEngine.Debug.Log($"[AshesOfPantheonQA] Package Bridge listening on 127.0.0.1:{m_port}");
        }

        private void WriteHeartbeat()
        {
            if (m_disposed) return;
            try
            {
                WriteRendezvousFile();
            }
            catch (Exception exception)
            {
                m_logger.LogWarning($"Package Bridge heartbeat failed: {exception.Message}");
            }
        }

        public void Dispose()
        {
            if (m_disposed) return;
            m_disposed = true;
            m_heartbeatTimer?.Dispose();
            m_heartbeatTimer = null;
            try { m_listener?.Stop(); }
            catch (Exception exception) { UnityEngine.Debug.LogWarning($"[AshesOfPantheonQA] Listener stop failed: {exception.Message}"); }
            try { m_listener?.Close(); }
            catch (Exception exception) { UnityEngine.Debug.LogWarning($"[AshesOfPantheonQA] Listener close failed: {exception.Message}"); }
            if (!string.IsNullOrEmpty(m_rendezvousPath))
            {
                try { if (File.Exists(m_rendezvousPath)) File.Delete(m_rendezvousPath); }
                catch (Exception exception) { UnityEngine.Debug.LogWarning($"[AshesOfPantheonQA] Rendezvous cleanup failed: {exception.Message}"); }
            }
        }

        private void ListenLoop()
        {
            while (!m_disposed && m_listener != null && m_listener.IsListening)
            {
                try
                {
                    var context = m_listener.GetContext();
                    ThreadPool.QueueUserWorkItem(_ => Handle(context));
                }
                catch (HttpListenerException) { if (!m_disposed) Thread.Sleep(100); }
                catch (ObjectDisposedException) { return; }
            }
        }

        private void Handle(HttpListenerContext context)
        {
            try
            {
                if (!string.Equals(context.Request.Headers["Authorization"], $"Bearer {m_token}", StringComparison.Ordinal))
                {
                    WriteJson(context.Response, 401, new { error = "unauthorized" });
                    return;
                }

                var path = context.Request.Url?.AbsolutePath ?? string.Empty;
                object payload;
                if (context.Request.HttpMethod == "GET" && path == "/api/status") payload = InvokeMain(m_adapter.GetStatus);
                else if (context.Request.HttpMethod == "GET" && path == "/api/catalog") payload = InvokeMain(m_adapter.GetCatalog);
                else if (context.Request.HttpMethod == "GET" && path == "/api/battle") payload = InvokeMain(m_adapter.GetBattleSnapshot);
                else if (context.Request.HttpMethod == "GET" && path == "/api/battle/route-preview") payload = InvokeMain(m_adapter.GetRoutePreviewSnapshot);
                else if (context.Request.HttpMethod == "POST" && path == "/api/entities/move")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    request["expiresAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 4000;
                    payload = InvokeMain(() => m_adapter.MoveEntity(request));
                }
                else if (context.Request.HttpMethod == "DELETE" && path == "/api/equipment")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = InvokeMain(() => m_adapter.RemoveEquipment(request));
                }
                else if (context.Request.HttpMethod == "GET" && path == "/api/cards") payload = InvokeMain(m_adapter.GetCardInventorySnapshot);
                else if (context.Request.HttpMethod == "POST" && path == "/api/cards")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = InvokeMain(() => m_adapter.AddOwnedCard(request));
                }
                else if (context.Request.HttpMethod == "DELETE" && path == "/api/cards")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = InvokeMain(() => m_adapter.RemoveOwnedCard(request));
                }
                else if (context.Request.HttpMethod == "POST" && path == "/api/player")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = InvokeMain(() => m_adapter.ApplyPlayer(request));
                }
                else if (context.Request.HttpMethod == "POST" && path == "/api/enemy")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = InvokeMain(() => m_adapter.ApplyEnemy(request));
                }
                else if (context.Request.HttpMethod == "POST" && path == "/api/buffs")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = InvokeMain(() => m_adapter.AddBuff(request));
                }
                else if (context.Request.HttpMethod == "DELETE" && path == "/api/buffs")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = InvokeMain(() => m_adapter.RemoveBuff(request));
                }
                else if (context.Request.HttpMethod == "PATCH" && path == "/api/buffs")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = InvokeMain(() => m_adapter.UpdateBuff(request));
                }
                else if (context.Request.HttpMethod == "POST" && path == "/api/blessings")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = InvokeMain(() => m_adapter.AddBlessing(request));
                }
                else if (context.Request.HttpMethod == "DELETE" && path == "/api/blessings")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = InvokeMain(() => m_adapter.RemoveBlessing(request));
                }
                else if (context.Request.HttpMethod == "POST" && path == "/api/intents")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = InvokeMain(() => m_adapter.ApplyIntents(request));
                }
                else if (context.Request.HttpMethod == "POST" && path == "/api/gm")
                {
                    var request = JsonConvert.DeserializeObject<GmRequest>(ReadBody(context.Request));
                    payload = InvokeMain(() => m_adapter.ExecuteGm(request?.Command));
                }
                else
                {
                    WriteJson(context.Response, 404, new { error = "route_not_found" });
                    return;
                }
                WriteJson(context.Response, 200, payload);
            }
            catch (Exception exception)
            {
                WriteJson(context.Response, 500, new { error = exception.Message });
            }
        }

        private object InvokeMain(Func<object> callback)
        {
            var workItem = new WorkItem(callback);
            m_unityContext.Post(_ => workItem.Execute(), null);
            if (!workItem.Wait(5000)) throw new TimeoutException("Game main thread did not answer in time.");
            if (workItem.Error != null) throw workItem.Error;
            return workItem.Result;
        }

        private static string ReadBody(HttpListenerRequest request)
        {
            using (var reader = new StreamReader(request.InputStream, request.ContentEncoding ?? Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        private void WriteJson(HttpListenerResponse response, int statusCode, object payload)
        {
            var bytes = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(payload, m_jsonSettings));
            response.StatusCode = statusCode;
            response.ContentType = "application/json; charset=utf-8";
            response.ContentLength64 = bytes.Length;
            response.OutputStream.Write(bytes, 0, bytes.Length);
            response.OutputStream.Close();
        }

        private void WriteRendezvousFile()
        {
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AshesOfPantheonQA", "instances");
            Directory.CreateDirectory(directory);
            m_rendezvousPath = Path.Combine(directory, $"{m_instanceId}.json");
            var payload = new
            {
                instanceId = m_instanceId,
                kind = "package",
                processId = Process.GetCurrentProcess().Id,
                displayName = m_displayName,
                gameVersion = m_gameVersion,
                sceneName = m_initialSceneName,
                port = m_port,
                token = m_token,
                lastSeenAt = DateTime.UtcNow.ToString("O")
            };
            File.WriteAllText(m_rendezvousPath, JsonConvert.SerializeObject(payload), new UTF8Encoding(false));
        }

        private static int ReservePort()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            return port;
        }

        private static string CreateToken()
        {
            var bytes = new byte[32];
            using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
            return string.Concat(bytes.Select(value => value.ToString("x2")));
        }

        private sealed class WorkItem
        {
            private readonly Func<object> m_callback;
            private readonly ManualResetEventSlim m_completed = new ManualResetEventSlim(false);
            public object Result { get; private set; }
            public Exception Error { get; private set; }

            public WorkItem(Func<object> callback) { m_callback = callback; }
            public void Execute()
            {
                try { Result = m_callback(); }
                catch (Exception exception) { Error = exception; }
                finally { m_completed.Set(); }
            }
            public void Fail(Exception error) { Error = error; m_completed.Set(); }
            public bool Wait(int milliseconds) { return m_completed.Wait(milliseconds); }
        }

        private sealed class GmRequest { public string Command { get; set; } }
    }

    internal sealed class QaGameReflectionAdapter
    {
        private const string GameAssembly = "HappyHotel";

        public object GetStatus()
        {
            return new { ready = true, mode = "package", gameVersion = Application.version, sceneName = SceneManager.GetActiveScene().name, unityVersion = Application.unityVersion, timestamp = DateTime.UtcNow.ToString("O") };
        }

        public object GetCatalog()
        {
            var cards = GetCards();
            return new
            {
                cards,
                equipment = cards.Where(card => card.category == "equipment").Select(card => new { card.typeId, card.name }).ToList(),
                buffs = GetRegistryEntries("HappyHotel.Buff.BuffRegistry", "buffNameLocalized").Select(entry => new { entry.typeId, entry.name, entry.description, supportsStacks = true, supportsDuration = true }).ToList(),
                blessings = GetRegistryEntries("HappyHotel.Donum.DonumRegistry", "itemNameLocalized").Select(entry => new { entry.typeId, entry.name, entry.description }).ToList(),
                intents = GetRegistryEntries("HappyHotel.Intent.IntentRegistry", "intentNameLocalized").Select(entry => new { entry.typeId, entry.name, entry.description, parameters = Array.Empty<string>() }).ToList()
            };
        }

        public object GetCardInventorySnapshot()
        {
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

        public object ApplyPlayer(JObject request)
        {
            var player = GetControllerObjects("HappyHotel.Character.CharacterController", "GetAllCharacters").FirstOrDefault(IsMainCharacter);
            if (player == null) return Failure("主角实例不可用。");
            var hitPoint = GetBehaviorComponent(player, "HappyHotel.Core.ValueProcessing.Components.HitPointValueComponent");
            var cost = GetSingleton("HappyHotel.GameManager.CostManager");
            var armorValue = request["shield"] == null
                ? null
                : ReadMember<object>(GetBehaviorComponent(player, "HappyHotel.Core.ValueProcessing.Components.ArmorValueComponent"), "ArmorValue");
            var attack = request["baseAttack"] == null
                ? null
                : GetBehaviorComponent(player, "HappyHotel.Core.ValueProcessing.Components.AttackPowerComponent");
            var money = request["gold"] == null ? null : GetSingleton("HappyHotel.Shop.ShopMoneyManager");
            if (hitPoint == null || cost == null) return Failure("玩家属性模块不可用。");
            if (request["shield"] != null && armorValue == null) return Failure("玩家护盾模块不可用。");
            if (request["baseAttack"] != null && attack == null) return Failure("玩家攻击模块不可用。");
            if (request["gold"] != null && money == null) return Failure("玩家金币模块不可用。");
            Invoke(hitPoint, "SetHitPoint", request.Value<int>("maxHp"), request.Value<int>("currentHp"));
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
            return Success("玩家属性已更新。");
        }

        public object ApplyEnemy(JObject request)
        {
            var enemy = FindTarget(request.Value<string>("instanceId"));
            if (enemy == null) return Failure("怪物实例不可用。");
            var hitPoint = GetBehaviorComponent(enemy, "HappyHotel.Core.ValueProcessing.Components.HitPointValueComponent");
            var attack = GetBehaviorComponent(enemy, "HappyHotel.Core.ValueProcessing.Components.AttackPowerComponent");
            if (hitPoint == null || attack == null) return Failure("怪物属性模块不可用。");
            Invoke(hitPoint, "SetHitPoint", request.Value<int>("maxHp"), request.Value<int>("currentHp"));
            Invoke(attack, "SetAttackPower", request["baseAttack"] != null ? request.Value<int>("baseAttack") : request.Value<int>("attack"));
            return Success("怪物属性已更新。");
        }

        public object RemoveEquipment(JObject request)
        {
            var targetId = request.Value<string>("moveTargetId");
            var prop = GetEquipmentObjects().FirstOrDefault(item => MoveTargetId(item) == targetId);
            if (prop == null) return Failure("装备实例不可用。");
            var controller = GetSingleton("HappyHotel.Prop.PropController");
            var reasonType = FindType("HappyHotel.Prop.PropRemovalReason");
            if (controller == null || reasonType == null) return Failure("装备移除模块不可用。");
            var card = Invoke(prop, "GetSourceEquipment");
            var deployment = GetSingleton("HappyHotel.Inventory.EquipmentCardDeploymentService");
            var temporary = card != null && Invoke(deployment, "IsTemporary", card) is bool value && value;
            if (!(Invoke(controller, "RemoveProp", prop, Enum.Parse(reasonType, "RunReset")) is bool removed) || !removed)
                return Failure("装备移除失败。");
            if (card != null && !temporary) ReleaseCardInstance(GetSingleton("HappyHotel.Card.CardManager"), card);
            return Success("装备已移除。");
        }

        public object AddBuff(JObject request)
        {
            var target = FindTarget(request.Value<string>("targetInstanceId"));
            var typeIdText = request.Value<string>("typeId");
            var container = GetBehaviorComponent(target, "HappyHotel.Buff.Components.BuffContainer");
            var manager = GetSingleton("HappyHotel.Buff.BuffManager");
            var registry = GetSingleton("HappyHotel.Buff.BuffRegistry");
            if (target == null || container == null || manager == null || registry == null) return Failure("BUFF 目标或模块不可用。");
            Invoke(registry, "Initialize");
            var typeId = Invoke(registry, "GetType", typeIdText);
            if (typeId == null) return Failure($"未注册的 BUFF TypeId：{typeIdText}");
            var setting = CreateSetting(registry, typeId, request);
            var buff = Invoke(manager, "Create", typeId, setting);
            if (buff == null) return Failure("BUFF 创建失败。");
            Invoke(container, "AddBuff", buff);
            return Success("BUFF 已添加。");
        }

        public object RemoveBuff(JObject request)
        {
            var target = FindTarget(request.Value<string>("targetInstanceId"));
            var container = GetBehaviorComponent(target, "HappyHotel.Buff.Components.BuffContainer");
            if (container == null) return Failure("BUFF 目标不可用。");
            var buffs = Enumerate(Invoke(container, "GetAllBuffs")).ToList();
            var index = ParseIndexedInstance(request.Value<string>("instanceId"), "buff-");
            if (index < 0 || index >= buffs.Count) return Failure("BUFF 实例不可用。");
            Invoke(container, "RemoveBuff", buffs[index]);
            return Success("BUFF 已移除。");
        }

        public object UpdateBuff(JObject request)
        {
            var target = FindTarget(request.Value<string>("targetInstanceId"));
            var container = GetBehaviorComponent(target, "HappyHotel.Buff.Components.BuffContainer");
            if (container == null) return Failure("BUFF 目标不可用。");
            var buffs = Enumerate(Invoke(container, "GetAllBuffs")).ToList();
            var index = ParseIndexedInstance(request.Value<string>("instanceId"), "buff-");
            if (index < 0 || index >= buffs.Count) return Failure("BUFF 实例不可用。");
            var buff = buffs[index];
            var expectedTypeId = request.Value<string>("typeId");
            if (!string.IsNullOrWhiteSpace(expectedTypeId) && !string.Equals(ResolveTypeId(buff), expectedTypeId, StringComparison.Ordinal))
                return Failure("BUFF 列表已变化，请刷新后重试。");
            Invoke(buff, "SetStacks", Math.Max(0, request.Value<int>("stacks")));
            return Success("BUFF 层数已更新。");
        }

        public object AddBlessing(JObject request)
        {
            var manager = GetSingleton("HappyHotel.Donum.DonumManager");
            var registry = GetSingleton("HappyHotel.Donum.DonumRegistry");
            var typeIdText = request.Value<string>("typeId");
            if (manager == null || registry == null) return Failure("祝福模块不可用。");
            Invoke(registry, "Initialize");
            var typeId = Invoke(registry, "GetType", typeIdText);
            if (typeId == null) return Failure($"未注册的祝福 TypeId：{typeIdText}");
            var blessing = Invoke(manager, "Create", typeId, null);
            return blessing == null ? Failure("祝福创建失败。") : Success("祝福已添加。");
        }

        public object RemoveBlessing(JObject request)
        {
            var manager = GetSingleton("HappyHotel.Donum.DonumManager");
            var typeIdText = request.Value<string>("typeId");
            if (manager == null) return Failure("祝福模块不可用。");
            var blessing = Enumerate(Invoke(manager, "GetAllObjects"))
                .FirstOrDefault(item => string.Equals(ResolveTypeId(item), typeIdText, StringComparison.Ordinal));
            if (blessing == null) return Failure("祝福实例不可用。");
            Invoke(manager, "Remove", blessing);
            return Success("祝福已移除。");
        }

        public object ApplyIntents(JObject request)
        {
            var enemy = FindTarget(request.Value<string>("instanceId"));
            var executor = GetBehaviorComponent(enemy, "HappyHotel.Intent.Components.TurnEndIntentExecutorComponent");
            var registry = GetSingleton("HappyHotel.Intent.IntentRegistry");
            var executorType = FindType("HappyHotel.Intent.Components.TurnEndIntentExecutorComponent");
            var planType = executorType?.GetNestedType("IntentPlan", BindingFlags.Public);
            if (executor == null || registry == null || planType == null) return Failure("意图模块不可用。");
            Invoke(registry, "Initialize");
            var groupType = executorType.GetNestedType("IntentGroupPlan", BindingFlags.Public);
            if (groupType == null) return Failure("意图组模块不可用。");
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
                    if (typeId == null) return Failure($"未注册的意图 TypeId：{typeIdText}");
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
            if (method == null) return Failure("意图序列设置器不可用。");
            method.Invoke(executor, new object[] { groups, request.Value<int>("loopStartIndex") });
            return Success("意图序列已更新。");
        }

        private static object FindTarget(string instanceId)
        {
            if (string.Equals(instanceId, "player-main", StringComparison.Ordinal))
                return GetControllerObjects("HappyHotel.Character.CharacterController", "GetAllCharacters").FirstOrDefault(IsMainCharacter);

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
            foreach (var property in values.Properties()) WriteConvertedMember(setting, property.Name, property.Value);
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
                property.SetValue(target, token.ToObject(property.PropertyType), null);
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
            if (property != null && property.CanWrite) property.SetValue(target, value, null);
        }

        private static int ParseIndexedInstance(string value, string prefix)
        {
            if (string.IsNullOrEmpty(value) || !value.StartsWith(prefix, StringComparison.Ordinal)) return -1;
            return int.TryParse(value.Substring(prefix.Length), out var index) ? index : -1;
        }

        public object GetBattleSnapshot()
        {
            var mapSize = GetMapSize();
            var characters = GetControllerObjects("HappyHotel.Character.CharacterController", "GetAllCharacters");
            var enemies = GetControllerObjects("HappyHotel.Enemy.EnemyController", "GetAllEnemies");
            return new
            {
                available = characters.Count > 0,
                sceneName = SceneManager.GetActiveScene().name,
                mapName = ResolveCurrentMapName(),
                width = mapSize.x,
                height = mapSize.y,
                turn = 0,
                phase = "runtime",
                player = BuildPlayer(characters.FirstOrDefault(IsMainCharacter)),
                movement = MovementAvailability(),
                routePreview = GetRoutePreview(),
                entities = enemies.Select((enemy, index) => BuildEntity(enemy, index)).Where(value => value != null).Concat(GetEquipmentEntities()).ToList()
            };
        }

        public object GetRoutePreviewSnapshot()
        {
            return GetRoutePreview();
        }

        public object ExecuteGm(string command)
        {
            var type = FindType("HappyHotel.Core.Debugging.GMCommandProcessor");
            var method = type?.GetMethod("Execute", BindingFlags.Public | BindingFlags.Static);
            if (method == null) return new { success = false, message = "GMCommandProcessor.Execute is unavailable." };
            var result = method.Invoke(null, new object[] { command });
            return new { success = ReadMember<bool>(result, "Success"), message = ReadMember<string>(result, "Message") ?? string.Empty, logType = ReadMember<object>(result, "LogType")?.ToString() };
        }

        private List<CardDto> GetCards()
        {
            var registry = GetSingleton("HappyHotel.Card.CardRegistry");
            if (registry == null) return new List<CardDto>();
            Invoke(registry, "Initialize");
            var result = new List<CardDto>();
            foreach (var entry in Enumerate(Invoke(registry, "GetAllIndexEntries")))
            {
                var typeId = ReadMember<string>(entry, "TypeId");
                var template = ReadMember<object>(entry, "template");
                if (string.IsNullOrWhiteSpace(typeId) || template == null) continue;
                var name = ResolveTemplateText(template, "itemNameLocalized", "ItemNames", "Name", typeId);
                result.Add(new CardDto
                {
                    typeId = typeId,
                    name = ChineseName(typeId, name),
                    description = ResolveTemplateText(template, "descriptionLocalized", "ItemDescriptions", "Description", typeId),
                    category = ResolveCardCategory(template),
                    cost = ReadMember<int>(template, "cardCost"),
                    rarity = (ReadMember<object>(template, "rarity")?.ToString() ?? "Common").ToLowerInvariant(),
                    tags = Enumerate(ReadMember<object>(template, "cardTagIds")).Select(value => value?.ToString()).Where(value => !string.IsNullOrWhiteSpace(value)).ToArray(),
                    imageUrl = EncodeSprite(ReadMember<Sprite>(template, "cardImage") ?? ReadMember<Sprite>(template, "icon"))
                });
            }
            return result.OrderBy(card => card.typeId, StringComparer.Ordinal).ToList();
        }

        private IEnumerable<RegistryEntryDto> GetRegistryEntries(string registryTypeName, string localizedNameField)
        {
            var registry = GetSingleton(registryTypeName);
            if (registry == null) return Array.Empty<RegistryEntryDto>();
            Invoke(registry, "Initialize");
            var entries = new List<RegistryEntryDto>();
            foreach (var entry in Enumerate(Invoke(registry, "GetAllIndexEntries")))
            {
                var typeId = ReadMember<string>(entry, "TypeId");
                if (string.IsNullOrWhiteSpace(typeId)) continue;
                var registeredType = Invoke(registry, "GetType", typeId);
                var template = ResolveRegistryTemplate(registryTypeName, entry, registeredType);
                entries.Add(new RegistryEntryDto
                {
                    typeId = typeId,
                    name = ChineseName(typeId, ResolveTemplateText(template, localizedNameField, "ItemNames", "Name", typeId)),
                    description = ResolveTemplateText(template, "descriptionLocalized", "ItemDescriptions", "Description", typeId)
                });
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
            if (player == null) return null;
            var hp = GetBehaviorComponent(player, "HappyHotel.Core.ValueProcessing.Components.HitPointValueComponent");
            var cost = GetSingleton("HappyHotel.GameManager.CostManager");
            var armor = GetBehaviorComponent(player, "HappyHotel.Core.ValueProcessing.Components.ArmorValueComponent");
            var attack = GetBehaviorComponent(player, "HappyHotel.Core.ValueProcessing.Components.AttackPowerComponent");
            var money = GetSingleton("HappyHotel.Shop.ShopMoneyManager");
            var donum = GetSingleton("HappyHotel.Donum.DonumManager");
            var point = GetGridPosition(player);
            var blessings = Enumerate(Invoke(donum, "GetAllObjects")).Select(item =>
            {
                var definition = ResolveRegistryEntry("HappyHotel.Donum.DonumRegistry", ResolveTypeId(item), "itemNameLocalized");
                return new { definition.typeId, definition.name, definition.description };
            }).ToArray();
            return new { instanceId = "player-main", moveTargetId = MoveTargetId(player), size = GridSize(player), name = "主角", position = new { x = point.x, y = point.y }, currentHp = ReadMember<int>(hp, "CurrentHitPoint"), maxHp = ReadMember<int>(hp, "MaxHitPoint"), currentCost = ReadMember<int>(cost, "CurrentCost"), maxCost = ReadMember<int>(cost, "MaxCost"), shield = ReadMember<int>(armor, "CurrentArmor"), baseAttack = ReadBaseAttack(attack), attack = ReadMember<int>(attack, "AttackPower"), gold = ReadMember<int>(money, "CurrentMoney"), blessings, buffs = GetBuffs(player) };
        }

        private object BuildEntity(object target, int index)
        {
            if (target == null) return null;
            var hp = GetBehaviorComponent(target, "HappyHotel.Core.ValueProcessing.Components.HitPointValueComponent");
            var attack = GetBehaviorComponent(target, "HappyHotel.Core.ValueProcessing.Components.AttackPowerComponent");
            var point = GetGridPosition(target);
            var typeId = ResolveTypeId(target);
            var executor = GetBehaviorComponent(target, "HappyHotel.Intent.Components.TurnEndIntentExecutorComponent");
            return new { instanceId = $"{typeId}#{index}", moveTargetId = MoveTargetId(target), size = GridSize(target), typeId, name = typeId, kind = "enemy", position = new { x = point.x, y = point.y }, currentHp = ReadMember<int>(hp, "CurrentHitPoint"), maxHp = ReadMember<int>(hp, "MaxHitPoint"), baseAttack = ReadBaseAttack(attack), attack = ReadMember<int>(attack, "AttackPower"), buffs = GetBuffs(target), intents = GetIntents(executor), loopStartIndex = executor == null ? -1 : Convert.ToInt32(Invoke(executor, "GetLoopStartIndex")) };
        }

        private object[] GetBuffs(object target)
        {
            var container = GetBehaviorComponent(target, "HappyHotel.Buff.Components.BuffContainer");
            return Enumerate(Invoke(container, "GetAllBuffs")).Select((buff, index) =>
            {
                var definition = ResolveRegistryEntry("HappyHotel.Buff.BuffRegistry", ResolveTypeId(buff), "buffNameLocalized");
                return new { instanceId = $"buff-{index}", definition.typeId, definition.name, stacks = ReadBuffStacks(buff), definition.description };
            }).Cast<object>().ToArray();
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
                    result.Add(new { instanceId = $"intent-{itemIndex++}", typeId, name = definition.name, summary = definition.description, parameters = ReadSettingParameters(ReadMember<object>(plan, "Setting")), groupIndex = group.index, projectileClassId = ReadMember<string>(plan, "ProjectileClassId") ?? string.Empty });
                }
            }
            return result.ToArray();
        }

        private static string ResolveTemplateText(object template, string member, string tableName, string keySuffix, string typeId)
        {
            if (template == null) return string.Empty;
            var localizedString = ReadMember<object>(template, member);
            var value = ResolveLocalizedTableEntry(ReadMember<object>(localizedString, "TableReference"), ReadMember<object>(localizedString, "TableEntryReference"));
            if (!IsMissingTranslation(value)) return value;

            var prefixCandidates = new List<string>();
            var declaredPrefix = ReadMember<string>(template, "LocalizationSystemPrefix");
            if (!string.IsNullOrWhiteSpace(declaredPrefix)) prefixCandidates.Add(declaredPrefix);
            if (IsInstanceOf(template, "HappyHotel.Card.Templates.EquipmentTemplate")) prefixCandidates.Add("Equipment");
            if (IsInstanceOf(template, "HappyHotel.Card.Templates.CardTemplate")) prefixCandidates.Add("Card");
            if (template.GetType().FullName?.Contains(".Buff.") == true) prefixCandidates.Add("Buff");
            if (template.GetType().FullName?.Contains(".Intent.") == true) prefixCandidates.Add("Intent");

            var slugCandidates = new List<string>();
            var declaredSlug = ReadMember<string>(template, "localizationSlug");
            if (!string.IsNullOrWhiteSpace(declaredSlug)) slugCandidates.Add(declaredSlug);
            var sourceName = template is UnityEngine.Object unityObject ? unityObject.name : template.GetType().Name;
            var templateSlug = ToKebabCase(sourceName);
            if (!string.IsNullOrWhiteSpace(templateSlug)) slugCandidates.Add(templateSlug);
            var typeSlug = ToKebabCase(typeId);
            if (!string.IsNullOrWhiteSpace(typeSlug))
            {
                slugCandidates.Add(typeSlug);
                slugCandidates.Add($"{typeSlug}-template");
            }
            if (!string.IsNullOrWhiteSpace(typeSlug))
            {
                var directTypeKey = ResolveLocalizedTableEntry(tableName, $"Equipment/{typeSlug}/{keySuffix}");
                if (!IsMissingTranslation(directTypeKey)) return directTypeKey;
            }

            if (string.Equals(keySuffix, "Name", StringComparison.Ordinal))
            {
                foreach (var source in new[] { sourceName, typeId })
                {
                    var equipmentName = TryResolveEquipmentNameFromCatalog(source, tableName);
                    if (!IsMissingTranslation(equipmentName)) return equipmentName;
                }
            }

            foreach (var prefix in prefixCandidates.Where(candidate => !string.IsNullOrWhiteSpace(candidate)).Distinct(StringComparer.Ordinal))
            {
                foreach (var slug in slugCandidates.Where(candidate => !string.IsNullOrWhiteSpace(candidate)).Distinct(StringComparer.Ordinal))
                {
                    var derived = ResolveLocalizedTableEntry(tableName, $"{prefix}/{slug}/{keySuffix}");
                    if (!IsMissingTranslation(derived)) return derived;
                }
            }
            return string.Empty;
        }

        private static RegistryEntryDto ResolveRegistryEntry(string registryTypeName, string typeId, string localizedNameField)
        {
            var registry = GetSingleton(registryTypeName);
            if (registry != null)
            {
                Invoke(registry, "Initialize");
                var registeredType = Invoke(registry, "GetType", typeId);
                var entry = registeredType == null ? null : Invoke(registry, "GetIndexEntry", registeredType);
                var template = ResolveRegistryTemplate(registryTypeName, entry, registeredType);
                return new RegistryEntryDto
                {
                    typeId = typeId,
                    name = ChineseName(typeId, ResolveTemplateText(template, localizedNameField, "ItemNames", "Name", typeId)),
                    description = ResolveTemplateText(template, "descriptionLocalized", "ItemDescriptions", "Description", typeId)
                };
            }
            return new RegistryEntryDto { typeId = typeId, name = ChineseName(typeId, string.Empty), description = string.Empty };
        }

        private static object ResolveRegistryTemplate(string registryTypeName, object entry, object registeredType)
        {
            var template = ReadMember<object>(entry, "TemplateObject") ?? ReadMember<object>(entry, "template");
            if (template != null || registeredType == null) return template;
            var managerTypeName = registryTypeName.Replace("Registry", "Manager");
            var resourceManager = Invoke(GetSingleton(managerTypeName), "GetResourceManager");
            return Invoke(resourceManager, "GetTemplate", registeredType);
        }

        private static int ReadBuffStacks(object buff)
        {
            var stacks = Invoke(buff, "GetStacks");
            return stacks is int count ? count : 1;
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
                var value = property.GetValue(setting, null);
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

        private static string TryResolveEquipmentNameFromCatalog(string source, string tableName)
        {
            if (string.IsNullOrWhiteSpace(source) || !string.Equals(tableName, "ItemNames", StringComparison.Ordinal)) return string.Empty;
            var words = SplitIdentifierWords(source)
                .Where(word => !string.Equals(word, "Template", StringComparison.OrdinalIgnoreCase) &&
                               !string.Equals(word, "Equipment", StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (words.Count == 0) return string.Empty;
            var candidates = new List<string>
            {
                string.Join("-", words).ToLowerInvariant()
            };
            if (words.Count > 1 && words[0].EndsWith("s", StringComparison.OrdinalIgnoreCase))
            {
                var singular = words.ToArray();
                singular[0] = singular[0].Substring(0, singular[0].Length - 1);
                candidates.Add(string.Join("-", singular).ToLowerInvariant());
            }
            foreach (var slug in candidates.Distinct(StringComparer.Ordinal))
            {
                var value = ResolveLocalizedTableEntry(tableName, $"Equipment/{slug}-template/Name");
                if (!IsMissingTranslation(value)) return value;
            }
            return string.Empty;
        }

        private static IEnumerable<string> SplitIdentifierWords(string value)
        {
            var normalized = value.Replace(" Template", string.Empty).Trim();
            var matches = System.Text.RegularExpressions.Regex.Matches(normalized, @"[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+");
            return matches.Cast<System.Text.RegularExpressions.Match>().Select(match => match.Value);
        }

        private static bool IsMissingTranslation(string value)
        {
            return string.IsNullOrWhiteSpace(value) ||
                   value.StartsWith("No translation found for '", StringComparison.Ordinal) ||
                   value.IndexOf("/", StringComparison.Ordinal) >= 0 && value.EndsWith("/Name", StringComparison.Ordinal);
        }

        private static string ResolveLocalizedTableEntry(string tableName, string key)
        {
            return ResolveLocalizedTableEntry((object)tableName, key);
        }

        private static string ResolveLocalizedTableEntry(object tableReference, object entryReference)
        {
            if (tableReference == null || entryReference == null) return string.Empty;
            try
            {
                var settingsType = FindAnyType("UnityEngine.Localization.Settings.LocalizationSettings");
                var database = settingsType?.GetProperty("StringDatabase", BindingFlags.Public | BindingFlags.Static)?.GetValue(null, null);
                var availableLocales = settingsType?.GetProperty("AvailableLocales", BindingFlags.Public | BindingFlags.Static)?.GetValue(null, null);
                if (database == null || availableLocales == null) return string.Empty;
                var getLocale = availableLocales.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                    .FirstOrDefault(candidate => candidate.Name == "GetLocale" && candidate.GetParameters().Length == 1 && candidate.GetParameters()[0].ParameterType == typeof(string));
                var locale = getLocale?.Invoke(availableLocales, new object[] { "zh-Hans" });
                if (locale == null) return string.Empty;
                var method = database.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                    .Where(candidate => candidate.Name == "GetLocalizedString")
                    .FirstOrDefault(candidate =>
                    {
                        var parameters = candidate.GetParameters();
                        return parameters.Length >= 2 &&
                               parameters[0].ParameterType.Name == "TableReference" &&
                               parameters[1].ParameterType.Name == "TableEntryReference";
                    });
                if (method == null) return string.Empty;
                var parameters = method.GetParameters();
                var arguments = new object[parameters.Length];
                arguments[0] = tableReference is string tableName ? CreateStringReference(parameters[0].ParameterType, tableName, "TableCollectionName", "ReferenceType", 2) : tableReference;
                arguments[1] = entryReference is string key ? CreateStringReference(parameters[1].ParameterType, key, "Key", "ReferenceType", 1) : entryReference;
                for (var index = 2; index < parameters.Length; index++)
                {
                    var parameter = parameters[index];
                    if (locale != null && parameter.ParameterType.IsInstanceOfType(locale)) arguments[index] = locale;
                    else if (parameter.HasDefaultValue) arguments[index] = parameter.DefaultValue;
                    else if (parameter.ParameterType.IsEnum) arguments[index] = Enum.ToObject(parameter.ParameterType, 0);
                    else arguments[index] = null;
                }
                return method.Invoke(database, arguments) as string ?? string.Empty;
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.LogWarning($"[AshesOfPantheonQA] Localization table lookup failed: {exception.Message}");
                return string.Empty;
            }
        }

        private static object CreateStringReference(Type referenceType, string value, string valuePropertyName, string typePropertyName, int referenceKind)
        {
            var reference = Activator.CreateInstance(referenceType);
            var valueProperty = referenceType.GetProperty(valuePropertyName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            var typeProperty = referenceType.GetProperty(typePropertyName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            valueProperty?.GetSetMethod(true)?.Invoke(reference, new object[] { value });
            if (typeProperty != null && typeProperty.PropertyType.IsEnum)
                typeProperty.GetSetMethod(true)?.Invoke(reference, new[] { Enum.ToObject(typeProperty.PropertyType, referenceKind) });
            return reference;
        }

        private static string ToKebabCase(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return string.Empty;
            var builder = new StringBuilder(value.Length + 12);
            for (var index = 0; index < value.Length; index++)
            {
                var character = value[index];
                var previous = index > 0 ? value[index - 1] : '\0';
                var next = index + 1 < value.Length ? value[index + 1] : '\0';
                var startsWord = index > 0 && char.IsUpper(character) &&
                    (char.IsLower(previous) || char.IsDigit(previous) || char.IsUpper(previous) && char.IsLower(next));
                if (startsWord && builder.Length > 0 && builder[builder.Length - 1] != '-') builder.Append('-');
                if (char.IsLetterOrDigit(character)) builder.Append(char.ToLowerInvariant(character));
                else if (builder.Length > 0 && builder[builder.Length - 1] != '-') builder.Append('-');
            }
            return builder.ToString().Trim('-');
        }

        private static string ChineseName(string typeId, string value)
        {
            if (!string.IsNullOrWhiteSpace(value)) return value;
            if (typeId == "ArmorAttackBonusBuff") return "护甲攻击增益";
            if (typeId == "ParryCounterBuff") return "招架反击";
            if (typeId == "AureliaDashAttack") return "奥蕾莉亚冲刺攻击";
            if (typeId == "MultiAttackMainCharacter") return "多次攻击玩家";
            if (typeId == "ArmorGainBonusCharm") return "护甲增益护符";
            if (typeId == "Card02") return "护甲";
            if (typeId == "Card07") return "长剑";
            if (typeId == "Card08") return "钢剑";
            if (typeId == "Card09") return "军团长剑";
            if (typeId == "Card10") return "百夫长剑";
            if (typeId == "Card15") return "军团护甲";
            if (typeId == "Card16") return "护卫护甲";
            if (typeId == "Card17") return "百夫长护甲";
            if (typeId == "Card18") return "精锐护甲";
            if (typeId == "Card19") return "军团箭矢";
            if (typeId == "Card20") return "穿甲箭";
            if (typeId == "Card22") return "军团圆盾";
            if (typeId == "Card23") return "塔盾";
            if (typeId == "Card24") return "反击盾";
            if (typeId == "Card25") return "军团头盔";
            if (typeId == "Card26") return "百夫长头盔";
            if (typeId == "Card27") return "精锐头盔";
            if (typeId == "Card28") return "军团护腕";
            if (typeId == "Card33") return "战术腰带";
            if (typeId == "Card34") return "军团战靴";
            if (typeId == "Card35") return "百夫长战靴";
            if (typeId == "Card36") return "精锐战靴";
            if (typeId == "Card37") return "战术手套";
            if (typeId == "Card38") return "军团披风";
            if (typeId == "Card39") return "百夫长披风";
            if (typeId == "CostCapCharm") return "费用上限护符";
            if (typeId == "EmblemOfTheJuggernautsValor") return "战神勇气徽记";
            if (typeId == "ExtraRefreshCharm") return "额外刷新护符";
            if (typeId == "Greatsword") return "双手巨剑";
            if (typeId == "GuardCharm") return "守护护符";
            if (typeId == "ImpureBladeOil") return "杂质刀油";
            if (typeId == "NextAttackPowerDebuffCharm") return "削弱护符";
            if (typeId == "OilOfBoarsFury") return "野猪之怒刀油";
            if (typeId == "OilOfMoltenFury") return "熔怒刀油";
            if (typeId == "OilOfWolfsFang") return "狼牙刀油";
            if (typeId == "OverflowCostCharm") return "费用溢出护符";
            if (typeId == "Pauldrons") return "肩甲";
            if (typeId == "PenanceCharm") return "苦修护符";
            if (typeId == "PotionOfFortitude") return "坚韧药剂";
            if (typeId == "RammingPauldrons") return "冲阵肩甲";
            if (typeId == "SpikedVambraces") return "尖刺臂甲";
            if (typeId == "SuperiorBladeOil") return "上等刀油";
            if (typeId == "TravelersBackpack") return "旅者背包";
            if (typeId == "VitalityCharm") return "活力护符";
            if (typeId == "WarBudgetGloves") return "战争预算手套";
            return $"未本地化 · {typeId}";
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

        private static string ResolveCardCategory(object template)
        {
            if (IsInstanceOf(template, "HappyHotel.Card.Templates.EquipmentTemplate")) return "equipment";
            if (IsInstanceOf(template, "HappyHotel.Card.Templates.DirectionalPlacementCardTemplate")) return "directional";
            if (IsInstanceOf(template, "HappyHotel.Card.Templates.TargetSelectionCardTemplate")) return "target";
            if (IsInstanceOf(template, "HappyHotel.Card.Templates.ActivePlacementCardTemplate")) return "placement";
            return "effect";
        }

        private static string EncodeSprite(Sprite sprite)
        {
            if (sprite == null || sprite.texture == null) return null;
            var rect = sprite.rect;
            var scale = Mathf.Min(1f, 320f / Mathf.Max(rect.width, rect.height));
            var width = Mathf.Max(1, Mathf.RoundToInt(rect.width * scale));
            var height = Mathf.Max(1, Mathf.RoundToInt(rect.height * scale));
            var target = RenderTexture.GetTemporary(width, height, 0, RenderTextureFormat.ARGB32);
            var previous = RenderTexture.active;
            Texture2D output = null;
            try
            {
                Graphics.Blit(sprite.texture, target, new Vector2(rect.width / sprite.texture.width, rect.height / sprite.texture.height), new Vector2(rect.x / sprite.texture.width, rect.y / sprite.texture.height));
                RenderTexture.active = target;
                output = new Texture2D(width, height, TextureFormat.RGBA32, false);
                output.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                output.Apply();
                return $"data:image/png;base64,{Convert.ToBase64String(output.EncodeToPNG())}";
            }
            finally
            {
                if (output != null) UnityEngine.Object.Destroy(output);
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(target);
            }
        }

        private static Vector2Int GetMapSize()
        {
            var value = Invoke(GetSingleton("HappyHotel.Map.LevelMapManager"), "GetMapSize");
            return value is Vector2Int size ? size : new Vector2Int(9, 9);
        }

        private static string ResolveCurrentMapName()
        {
            var data = Invoke(GetSingleton("HappyHotel.Map.LevelMapStorageManager"), "GetCurrentMapData");
            return ReadMember<string>(data, "mapName") ?? SceneManager.GetActiveScene().name;
        }

        private static List<object> GetControllerObjects(string typeName, string method)
        {
            return Enumerate(Invoke(GetSingleton(typeName), method)).ToList();
        }

        private static bool IsMainCharacter(object character)
        {
            return string.Equals(ReadMember<string>(character, "CharacterId"), "MainCharacter", StringComparison.Ordinal) || character is Component component && component.CompareTag("MainCharacter");
        }

        private static Vector2Int GetGridPosition(object target)
        {
            var value = Invoke(GetBehaviorComponent(target, "HappyHotel.Core.Grid.Components.GridObjectComponent"), "GetGridPosition");
            return value is Vector2Int point ? point : Vector2Int.zero;
        }

        private static object GetBehaviorComponent(object target, string typeName)
        {
            var type = FindType(typeName);
            if (target == null || type == null) return null;
            var method = target.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance).FirstOrDefault(candidate => candidate.Name == "GetBehaviorComponent" && candidate.IsGenericMethodDefinition && candidate.GetParameters().Length == 0);
            return method?.MakeGenericMethod(type).Invoke(target, null);
        }

        private static string ResolveLocalized(object localizedString)
        {
            if (localizedString == null) return string.Empty;
            try
            {
                var resolver = FindType("HappyHotel.Core.Localization.LocalizedStringResolver");
                var resolve = resolver?.GetMethod("Resolve", BindingFlags.Public | BindingFlags.Static);
                var resolved = resolve?.Invoke(null, new[] { localizedString }) as string;
                if (!string.IsNullOrWhiteSpace(resolved)) return resolved;

                var getLocalizedString = localizedString.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                    .FirstOrDefault(candidate => candidate.Name == "GetLocalizedString" && candidate.GetParameters().Length == 0);
                return getLocalizedString?.Invoke(localizedString, null) as string ?? string.Empty;
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.LogWarning($"[AshesOfPantheonQA] Localization lookup failed: {exception.Message}");
                return string.Empty;
            }
        }

        private static bool IsInstanceOf(object value, string typeName)
        {
            var type = FindType(typeName);
            return value != null && type != null && type.IsInstanceOfType(value);
        }

        private static string ResolveTypeId(object target)
        {
            var raw = ReadMember<object>(target, "TypeId") ?? ReadMember<object>(target, "typeId");
            return ReadMember<string>(raw, "Id") ?? raw?.ToString() ?? target?.GetType().Name ?? "Unknown";
        }

        private static object GetSingleton(string typeName)
        {
            var type = FindType(typeName);
            return type?.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy)?.GetValue(null, null);
        }

        private static Type FindType(string fullName)
        {
            return Type.GetType($"{fullName}, {GameAssembly}") ?? AppDomain.CurrentDomain.GetAssemblies().Select(assembly => assembly.GetType(fullName, false)).FirstOrDefault(type => type != null);
        }

        private static Type FindAnyType(string fullName)
        {
            return Type.GetType(fullName) ?? AppDomain.CurrentDomain.GetAssemblies().Select(assembly => assembly.GetType(fullName, false)).FirstOrDefault(type => type != null);
        }

        private static object Invoke(object target, string methodName, params object[] arguments)
        {
            if (target == null) return null;
            var methods = target.GetType().GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                .Where(method => method.Name == methodName && !method.IsGenericMethodDefinition && method.GetParameters().Length == arguments.Length);
            var method = methods.FirstOrDefault(candidate => candidate.GetParameters()
                .Select(parameter => parameter.ParameterType)
                .Zip(arguments, (type, argument) => argument == null || type.IsInstanceOfType(argument))
                .All(matches => matches));
            return method?.Invoke(target, arguments);
        }

        private static IEnumerable<object> Enumerate(object value)
        {
            if (!(value is IEnumerable enumerable)) yield break;
            foreach (var item in enumerable) yield return item;
        }

        private static T ReadMember<T>(object target, string name)
        {
            if (target == null) return default(T);
            var type = target.GetType();
            var property = type.GetProperty(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            var value = property != null ? property.GetValue(target, null) : type.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(target);
            return value is T typed ? typed : default(T);
        }

        private sealed class CardDto { public string typeId; public string name; public string description; public string category; public int cost; public string rarity; public string[] tags; public string imageUrl; }
        private sealed class RegistryEntryDto { public string typeId; public string name; public string description; }
    }
}
