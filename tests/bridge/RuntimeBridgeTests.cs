using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;

internal static class RuntimeBridgeTests
{
    private static void Check(bool value, string message)
    {
        if (!value) throw new Exception(message);
    }

    internal static void Run(object adapter)
    {
        HappyHotel.Character.CharacterController.Instance.Player = new HappyHotel.Character.MainCharacter();
        HappyHotel.Enemy.EnemyController.Instance.Enemies = new List<HappyHotel.Enemy.Enemy> { new HappyHotel.Enemy.Enemy() };
        HappyHotel.GameManager.CostManager.Instance.SetCost(2, 5, true);
        HappyHotel.Shop.ShopMoneyManager.Instance.SetCurrentMoney(41);
        HappyHotel.Donum.DonumManager.Instance.Reset();

        var snapshotMethod = adapter.GetType().GetMethod("GetBattleSnapshot");
        var initial = JObject.FromObject(snapshotMethod.Invoke(adapter, null));
        var player = initial["player"];
        Check(player["shield"].Value<int>() == 6, "Player shield must come from ArmorValueComponent");
        Check(player["baseAttack"].Value<int>() == 7, "Player base attack must come from the run attack value");
        Check(player["attack"].Value<int>() == 11, "Player actual attack must include runtime modifiers");
        Check(player["gold"].Value<int>() == 41, "Player gold must come from ShopMoneyManager");
        Check(player["blessings"].Count() == 1, "Runtime blessings must be returned in the battle snapshot");
        Check(player["blessings"][0]["name"].Value<string>() == "测试祝福", "Runtime blessing names must use Chinese localization");
        Check(player["buffs"][0]["stacks"].Value<int>() == 3, "BUFF stacks must come from GetStacks");

        var route = initial["routePreview"];
        Check(route != null && route["steps"].Count() == 3, "Battle snapshot must include the current route preview");
        Check(route["terminalPosition"]["x"].Value<int>() == 2 && route["terminalPosition"]["y"].Value<int>() == 1, "Route preview must expose its terminal cell");
        Check(route["stopReason"].Value<string>() == "Blocked", "Route preview must preserve the game stop reason");
        var routeMethod = adapter.GetType().GetMethod("GetRoutePreviewSnapshot");
        Check(routeMethod != null, "Bridge must expose a lightweight route preview endpoint");
        var directRoute = JObject.FromObject(routeMethod.Invoke(adapter, null));
        Check(directRoute["steps"].Count() == 3, "Lightweight route preview must match the battle snapshot");

        var applyPlayer = adapter.GetType().GetMethod("ApplyPlayer");
        var update = JObject.FromObject(applyPlayer.Invoke(adapter, new object[]
        {
            new JObject
            {
                ["maxHp"] = 44,
                ["currentHp"] = 33,
                ["currentCost"] = 6,
                ["maxCost"] = 8,
                ["shield"] = 12,
                ["baseAttack"] = 15,
                ["gold"] = 99
            }
        }));
        Check(update["success"].Value<bool>(), update.ToString());
        var updated = JObject.FromObject(snapshotMethod.Invoke(adapter, null))["player"];
        Check(updated["maxHp"].Value<int>() == 44 && updated["currentHp"].Value<int>() == 33, "Player HP update must reach the game component");
        Check(updated["maxCost"].Value<int>() == 8 && updated["currentCost"].Value<int>() == 6, "Player cost update must reach CostManager");
        Check(updated["shield"].Value<int>() == 12, "Player shield update must reach ArmorValue");
        Check(updated["baseAttack"].Value<int>() == 15 && updated["attack"].Value<int>() == 19, "Base and actual attack must remain distinct after update");
        Check(updated["gold"].Value<int>() == 99, "Player gold update must reach ShopMoneyManager");

        var runtimePlayer = HappyHotel.Character.CharacterController.Instance.Player;
        var hpBeforeFailure = runtimePlayer.HitPoint.CurrentHitPoint;
        var costBeforeFailure = HappyHotel.GameManager.CostManager.Instance.CurrentCost;
        var armor = runtimePlayer.Armor;
        runtimePlayer.Armor = null;
        var rejected = JObject.FromObject(applyPlayer.Invoke(adapter, new object[]
        {
            new JObject
            {
                ["maxHp"] = 1,
                ["currentHp"] = 1,
                ["currentCost"] = 1,
                ["maxCost"] = 1,
                ["shield"] = 1
            }
        }));
        Check(!rejected["success"].Value<bool>(), "Player update must reject a missing requested module");
        Check(runtimePlayer.HitPoint.CurrentHitPoint == hpBeforeFailure && HappyHotel.GameManager.CostManager.Instance.CurrentCost == costBeforeFailure,
            "Rejected player updates must not partially modify HP or cost");
        runtimePlayer.Armor = armor;

        var updateBuff = adapter.GetType().GetMethod("UpdateBuff");
        var buffResult = JObject.FromObject(updateBuff.Invoke(adapter, new object[]
        {
            new JObject { ["targetInstanceId"] = "player-main", ["instanceId"] = "buff-0", ["typeId"] = "ArmorAttackBonusBuff", ["stacks"] = 8 }
        }));
        Check(buffResult["success"].Value<bool>(), buffResult.ToString());
        Check(runtimePlayer.Buffs.Buffs[0].GetStacks() == 8, "BUFF stack update must call SetStacks on the selected instance");

        var battle = JObject.FromObject(snapshotMethod.Invoke(adapter, null));
        var enemy = battle["entities"].First(item => item["kind"].Value<string>() == "enemy");
        var applyIntents = adapter.GetType().GetMethod("ApplyIntents");
        var intentResult = JObject.FromObject(applyIntents.Invoke(adapter, new object[]
        {
            new JObject
            {
                ["instanceId"] = enemy["instanceId"].Value<string>(),
                ["loopStartIndex"] = 1,
                ["steps"] = new JArray
                {
                    new JObject { ["typeId"] = "AureliaDashAttack", ["groupIndex"] = 0, ["projectileClassId"] = "Fire", ["parameters"] = new JObject { ["damage"] = 7, ["enabled"] = true } },
                    new JObject { ["typeId"] = "MultiAttackMainCharacter", ["groupIndex"] = 0, ["projectileClassId"] = "Ice", ["parameters"] = new JObject { ["damage"] = 3, ["enabled"] = false } },
                    new JObject { ["typeId"] = "AureliaDashAttack", ["groupIndex"] = 1, ["projectileClassId"] = "Arc", ["parameters"] = new JObject { ["damage"] = 9, ["enabled"] = true } }
                }
            }
        }));
        Check(intentResult["success"].Value<bool>(), intentResult.ToString());
        var executor = HappyHotel.Enemy.EnemyController.Instance.Enemies[0].Intents;
        Check(executor.GetGroupSequence().Count == 2 && executor.GetGroupSequence()[0].Intents.Count == 2, "Intent steps in the same group must remain grouped");
        Check(executor.GetLoopStartIndex() == 1, "Intent loop start must be applied");
        Check(executor.GetGroupSequence()[0].Intents[0].ProjectileClassId == "Fire", "Intent projectile class must be applied");
        Check(((HappyHotel.Intent.RuntimeIntentSetting)executor.GetGroupSequence()[0].Intents[0].Setting).damage == 7,
            "Intent setting values must be converted and applied");
        var refreshedEnemy = JObject.FromObject(snapshotMethod.Invoke(adapter, null))["entities"].First(item => item["kind"].Value<string>() == "enemy");
        Check(refreshedEnemy["intents"].Count() == 3 && refreshedEnemy["intents"][1]["groupIndex"].Value<int>() == 0,
            "Updated intent groups must round-trip through the battle snapshot");
        Check(refreshedEnemy["intents"][0]["name"].Value<string>() == "奥蕾莉亚冲刺攻击", "Runtime intent names must use Chinese localization");

        var removeBlessing = adapter.GetType().GetMethod("RemoveBlessing");
        var blessingResult = JObject.FromObject(removeBlessing.Invoke(adapter, new object[] { new JObject { ["typeId"] = "TestBlessing" } }));
        Check(blessingResult["success"].Value<bool>(), blessingResult.ToString());
        Check(HappyHotel.Donum.DonumManager.Instance.GetAllObjects().Count == 0, "Blessing deletion must remove the owned runtime instance");
    }
}

namespace HappyHotel.Core.ValueProcessing.Components
{
    public class RuntimeIntValue
    {
        public int CurrentValue { get; private set; }
        public RuntimeIntValue(int value) { CurrentValue = value; }
        public void SetCurrentValue(int value) { CurrentValue = value; }
    }

    public class HitPointValueComponent
    {
        public int MaxHitPoint { get; private set; } = 30;
        public int CurrentHitPoint { get; private set; } = 20;
        public void SetHitPoint(int max, int current) { MaxHitPoint = max; CurrentHitPoint = current; }
    }

    public class ArmorValueComponent
    {
        public RuntimeIntValue ArmorValue { get; } = new RuntimeIntValue(6);
        public int CurrentArmor => ArmorValue.CurrentValue;
    }

    public class AttackPowerComponent
    {
        public RuntimeIntValue runAttackValue;
        private readonly int modifier;
        public AttackPowerComponent(int baseAttack, int modifier) { runAttackValue = new RuntimeIntValue(baseAttack); this.modifier = modifier; }
        public int AttackPower => runAttackValue.CurrentValue + modifier;
        public void SetAttackPower(int value) { runAttackValue.SetCurrentValue(value); }
    }
}

namespace HappyHotel.GameManager
{
    public class CostManager
    {
        public static CostManager Instance { get; } = new CostManager();
        public int CurrentCost { get; private set; }
        public int MaxCost { get; private set; }
        public void SetCost(int current, int max, bool raiseEvent) { CurrentCost = current; MaxCost = max; }
    }
}

namespace HappyHotel.Shop
{
    public class ShopMoneyManager
    {
        public static ShopMoneyManager Instance { get; } = new ShopMoneyManager();
        public int CurrentMoney { get; private set; }
        public void SetCurrentMoney(int value) { CurrentMoney = value; }
    }
}

namespace HappyHotel.Buff
{
    public class RuntimeBuff
    {
        public string TypeId { get; set; } = "ArmorAttackBonusBuff";
        private int stacks = 3;
        public int GetStacks() => stacks;
        public void SetStacks(int value) { stacks = value; }
    }

    public class BuffTemplate : UnityEngine.Object
    {
        public string LocalizationSystemPrefix => "Buff";
        public string localizationSlug = "test-buff";
        public UnityEngine.Localization.LocalizedString buffNameLocalized = RuntimeLocalization.Text("Buff/TestBuff/Name");
        public UnityEngine.Localization.LocalizedString descriptionLocalized = RuntimeLocalization.Text("Buff/TestBuff/Description");
    }

    public class BuffIndexEntry
    {
        public string TypeId = "ArmorAttackBonusBuff";
        public BuffTemplate template = new BuffTemplate();
        public object TemplateObject => template;
        public Type SettingType => typeof(RuntimeBuffSetting);
    }

    public class RuntimeBuffSetting { public int stacks; }

    public class BuffRegistry
    {
        public static BuffRegistry Instance { get; } = new BuffRegistry();
        private readonly BuffIndexEntry entry = new BuffIndexEntry();
        public void Initialize() { }
        public string GetType(string typeId) => typeId == entry.TypeId ? typeId : null;
        public BuffIndexEntry GetIndexEntry(string typeId) => typeId == entry.TypeId ? entry : null;
        public IEnumerable<BuffIndexEntry> GetAllIndexEntries() { yield return entry; }
    }
}

namespace HappyHotel.Buff.Components
{
    public class BuffContainer
    {
        public List<HappyHotel.Buff.RuntimeBuff> Buffs { get; } = new List<HappyHotel.Buff.RuntimeBuff> { new HappyHotel.Buff.RuntimeBuff() };
        public IEnumerable<HappyHotel.Buff.RuntimeBuff> GetAllBuffs() => Buffs;
        public void AddBuff(HappyHotel.Buff.RuntimeBuff buff) { Buffs.Add(buff); }
        public void RemoveBuff(HappyHotel.Buff.RuntimeBuff buff) { Buffs.Remove(buff); }
    }
}

namespace HappyHotel.Donum
{
    public class RuntimeDonum { public string TypeId { get; set; } = "TestBlessing"; }

    public class DonumTemplate : UnityEngine.Object
    {
        public string LocalizationSystemPrefix => "Donum";
        public string localizationSlug = "test-blessing";
        public UnityEngine.Localization.LocalizedString itemNameLocalized = RuntimeLocalization.Text("Donum/TestBlessing/Name");
        public UnityEngine.Localization.LocalizedString descriptionLocalized = RuntimeLocalization.Text("Donum/TestBlessing/Description");
    }

    public class DonumIndexEntry
    {
        public string TypeId = "TestBlessing";
        public DonumTemplate template = new DonumTemplate();
        public object TemplateObject => template;
    }

    public class DonumRegistry
    {
        public static DonumRegistry Instance { get; } = new DonumRegistry();
        private readonly DonumIndexEntry entry = new DonumIndexEntry();
        public void Initialize() { }
        public string GetType(string typeId) => typeId == entry.TypeId ? typeId : null;
        public DonumIndexEntry GetIndexEntry(string typeId) => typeId == entry.TypeId ? entry : null;
        public IEnumerable<DonumIndexEntry> GetAllIndexEntries() { yield return entry; }
    }

    public class DonumManager
    {
        public static DonumManager Instance { get; } = new DonumManager();
        private readonly List<RuntimeDonum> objects = new List<RuntimeDonum>();
        public List<RuntimeDonum> GetAllObjects() => objects;
        public object Create(string typeId, object setting) { var item = new RuntimeDonum { TypeId = typeId }; objects.Add(item); return item; }
        public void Remove(RuntimeDonum item) { objects.Remove(item); }
        public void Reset() { objects.Clear(); objects.Add(new RuntimeDonum()); }
    }
}

namespace HappyHotel.Intent
{
    public class RuntimeIntentSetting
    {
        public int damage;
        public bool enabled;
    }

    public class IntentTemplate : UnityEngine.Object
    {
        public string LocalizationSystemPrefix => "Intent";
        public string localizationSlug;
        public UnityEngine.Localization.LocalizedString intentNameLocalized;
        public UnityEngine.Localization.LocalizedString descriptionLocalized;
        public IntentTemplate(string typeId)
        {
            localizationSlug = typeId;
            intentNameLocalized = RuntimeLocalization.Text("Intent/" + typeId + "/Name");
            descriptionLocalized = RuntimeLocalization.Text("Intent/" + typeId + "/Description");
        }
    }

    public class IntentIndexEntry
    {
        public string TypeId;
        public IntentTemplate template;
        public object TemplateObject => template;
        public Type SettingType => typeof(RuntimeIntentSetting);
        public IntentIndexEntry(string typeId) { TypeId = typeId; template = new IntentTemplate(typeId); }
    }

    public class IntentRegistry
    {
        public static IntentRegistry Instance { get; } = new IntentRegistry();
        private readonly List<IntentIndexEntry> entries = new List<IntentIndexEntry>
        {
            new IntentIndexEntry("AureliaDashAttack"),
            new IntentIndexEntry("MultiAttackMainCharacter")
        };
        public void Initialize() { }
        public string GetType(string typeId) => entries.Any(entry => entry.TypeId == typeId) ? typeId : null;
        public IntentIndexEntry GetIndexEntry(string typeId) => entries.FirstOrDefault(entry => entry.TypeId == typeId);
        public IEnumerable<IntentIndexEntry> GetAllIndexEntries() => entries;
    }
}

namespace HappyHotel.Intent.Components
{
    public class TurnEndIntentExecutorComponent
    {
        public struct IntentPlan
        {
            public string TypeId;
            public object Setting;
            public string ProjectileClassId;
        }

        public struct IntentGroupPlan { public List<IntentPlan> Intents; }

        private List<IntentGroupPlan> groups = new List<IntentGroupPlan>();
        private int loopStartIndex = -1;
        public IReadOnlyList<IntentGroupPlan> GetGroupSequence() => groups;
        public int GetLoopStartIndex() => loopStartIndex;
        public void SetGroupSequenceWithLoopStart(IEnumerable<IntentGroupPlan> sequence, int loopStart)
        {
            groups = sequence.ToList();
            loopStartIndex = loopStart;
        }
    }
}

namespace HappyHotel.Prop.RoutePreview
{
    public enum RoutePreviewStopReason { Blocked }
    public class RoutePreviewStep { public Vector2Int Position; }
    public class RoutePreviewResult
    {
        public Vector2Int StartPosition;
        public List<RoutePreviewStep> Steps = new List<RoutePreviewStep>();
        public bool HasLoop;
        public bool HasTerminalPosition;
        public Vector2Int TerminalPosition;
        public RoutePreviewStopReason StopReason;
        public static RoutePreviewResult Sample() => new RoutePreviewResult
        {
            StartPosition = new Vector2Int(-1, -1),
            Steps = new List<RoutePreviewStep>
            {
                new RoutePreviewStep { Position = new Vector2Int(0, -1) },
                new RoutePreviewStep { Position = new Vector2Int(1, 0) },
                new RoutePreviewStep { Position = new Vector2Int(2, 1) }
            },
            HasTerminalPosition = true,
            TerminalPosition = new Vector2Int(2, 1),
            StopReason = RoutePreviewStopReason.Blocked
        };
    }
}

internal static class RuntimeLocalization
{
    internal static UnityEngine.Localization.LocalizedString Text(string key)
    {
        return new UnityEngine.Localization.LocalizedString
        {
            TableReference = new UnityEngine.Localization.Tables.TableReference { TableCollectionName = "RuntimeTests" },
            TableEntryReference = new UnityEngine.Localization.Tables.TableEntryReference { Key = key }
        };
    }
}
