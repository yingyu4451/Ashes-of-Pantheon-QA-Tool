using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;

// These fixtures emulate the external Unity/game interface; no Unity project is loaded or modified.
internal static class EquipmentBridgeTests
{
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static int Main(string[] args)
    {
        var adapters = new object[] { new AshesOfPantheon.QA.EditorBridge.QaGameReflectionAdapter(), new AshesOfPantheon.QA.PackageBridge.QaGameReflectionAdapter() };
        foreach (var adapter in adapters)
        {
            if (args.Contains("movement")) MovementBridgeTests.Run(adapter);
            if (args.Contains("catalog"))
            {
                var catalog = JObject.FromObject(adapter.GetType().GetMethod("GetCatalog").Invoke(adapter, null));
                Check(catalog["equipment"][0]["name"].Value<string>() == "真实中文长剑", adapter.GetType().Namespace + ": explicit Chinese locale must beat English current locale");
                Check(catalog["equipment"][1]["name"].Value<string>() == "第十八军团臂章", "Blank references must recover real registered table keys");
                Check(HappyHotel.Card.CardRegistry.Instance.Entries[0].template.itemNameLocalized.LocaleOverride == null, "Do not mutate the game template locale");
            }
            if (args.Contains("battle"))
            {
                var snapshot = JObject.FromObject(adapter.GetType().GetMethod("GetBattleSnapshot").Invoke(adapter, null));
                var equipment = snapshot["entities"].Where(item => item["kind"].Value<string>() == "equipment").ToList();
                Check(equipment.Count == 2, adapter.GetType().Namespace + ": include bound and non-bound equipment, exclude removed props");
                Check(equipment.Select(item => item["instanceId"].Value<string>()).Distinct().Count() == 2, "Same TypeId must not collapse separate equipment instances");
                Check(equipment.All(item => item["typeId"].Value<string>() == "Equipment01"), "Use source card TypeId, not Prop class ID");
                Check(equipment[0]["position"]["x"].Value<int>() == -2 && equipment[0]["position"]["y"].Value<int>() == 1, "Preserve grid coordinates");
                Check(equipment[0]["name"].Value<string>() == "真实中文长剑", "Equipment snapshot name must be localized");
                HappyHotel.Prop.PropController.Instance.Props.RemoveAt(0);
                var after = JObject.FromObject(adapter.GetType().GetMethod("GetBattleSnapshot").Invoke(adapter, null));
                Check(after["entities"].Count(item => item["kind"].Value<string>() == "equipment") == 1, "Removed equipment must disappear in next snapshot");
                HappyHotel.Prop.PropController.Reset();
            }
        }
        Console.WriteLine("Both Bridge adapters passed: " + string.Join(", ", args));
        return 0;
    }
}

namespace UnityEngine
{
    public class Object { static int next; readonly int id = ++next; public string name; public int GetInstanceID() => id; public static void Destroy(Object o) {} public static void DestroyImmediate(Object o) {} }
    public class Component : Object { public bool CompareTag(string tag) => false; public T GetComponent<T>() where T : class => null; public Component GetComponent(Type t) => null; }
    public class MonoBehaviour : Component {}
    public struct Vector2Int { public int x, y; public Vector2Int(int x, int y) { this.x=x; this.y=y; } public static Vector2Int zero => new Vector2Int(); }
    public struct Vector2 { public Vector2(float x, float y) {} }
    public struct Rect { public float x,y,width,height; public Rect(float x,float y,float width,float height) { this.x=x; this.y=y; this.width=width; this.height=height; } }
    public class Texture : Object { public int width, height; }
    public class Sprite : Object { public Texture texture; public Rect rect; }
    public class Texture2D : Texture { public Texture2D(int w,int h,TextureFormat f,bool m) {} public void ReadPixels(Rect r,int x,int y) {} public void Apply() {} public byte[] EncodeToPNG() => new byte[0]; }
    public enum TextureFormat { RGBA32 }
    public enum RenderTextureFormat { ARGB32 }
    public class RenderTexture : Texture { public static RenderTexture active; public static RenderTexture GetTemporary(int w,int h,int d,RenderTextureFormat f)=>new RenderTexture(); public static void ReleaseTemporary(RenderTexture t) {} }
    public static class Graphics { public static void Blit(Texture s,RenderTexture t,Vector2 a,Vector2 b) {} }
    public static class Mathf { public static float Min(float a,float b)=>Math.Min(a,b); public static float Max(float a,float b)=>Math.Max(a,b); public static int Max(int a,int b)=>Math.Max(a,b); public static int RoundToInt(float f)=>(int)f; }
    public static class Debug { public static void Log(object o) {} public static void LogWarning(object o) {} }
    public static class Application { public static string version="1", unityVersion="test", productName="test"; public static event Action quitting; }
}
namespace UnityEngine.SceneManagement { public class Scene { public string name="Battle"; } public static class SceneManager { public static Scene GetActiveScene()=>new Scene(); } }
namespace UnityEditor { public static class EditorApplication { public static bool isPlaying=true; } }
namespace BepInEx { public class BepInPlugin : Attribute { public BepInPlugin(string id,string name,string version) {} } public class BaseUnityPlugin : UnityEngine.MonoBehaviour { public Logging.ManualLogSource Logger = new Logging.ManualLogSource(); } }
namespace BepInEx.Logging { public class ManualLogSource { public void LogInfo(object o) {} public void LogError(object o) {} public void LogWarning(object o) {} } }

namespace UnityEngine.Localization.Tables
{
    public struct TableReference { public enum Type { Empty, Guid, Name } public string TableCollectionName { get; set; } public Type ReferenceType { get; set; } }
    public struct TableEntryReference { public enum Type { Empty, Name, Id } public string Key { get; set; } public Type ReferenceType { get; set; } }
}
namespace UnityEngine.Localization
{
    public class Locale { public string Code; }
    public class LocalizedString
    {
        public Tables.TableReference TableReference { get; set; }
        public Tables.TableEntryReference TableEntryReference { get; set; }
        public Locale LocaleOverride { get; set; }
        public string GetLocalizedString() => Settings.LocalizationSettings.StringDatabase.GetLocalizedString(TableReference, TableEntryReference, LocaleOverride);
    }
}
namespace UnityEngine.Localization.Settings
{
    public class LocalesProvider { public Locale GetLocale(string code) => new Locale { Code=code }; }
    public class StringDatabase
    {
        public string GetLocalizedString(Tables.TableReference table, Tables.TableEntryReference entry, Locale locale=null)
        {
            if (entry.Key == "Equipment/equipment-01/Name") return locale?.Code == "zh-Hans" ? "真实中文长剑" : "English Sword";
            if (entry.Key == "Equipment/armilla-legio-xviii-template/Name") return locale?.Code == "zh-Hans" ? "第十八军团臂章" : "Armilla";
            return "No translation found for '" + entry.Key + "'";
        }
    }
    public static class LocalizationSettings { public static StringDatabase StringDatabase { get; } = new StringDatabase(); public static LocalesProvider AvailableLocales { get; } = new LocalesProvider(); }
}
namespace HappyHotel.Core.Localization
{
    public static class LocalizedStringResolver { public static string Resolve(UnityEngine.Localization.LocalizedString value) => value?.GetLocalizedString() ?? ""; }
    public static class LocalizationSlugUtility { public static string BuildSlug(string name,string fallback) => name.ToLowerInvariant().Replace(' ', '-'); }
}
namespace HappyHotel.Core.Localization.Editor
{
    public static class LocalizedStringTableEditorUtility { public static string GetLocaleText(UnityEngine.Localization.LocalizedString value,string locale,string fallback) { var text=value==null ? "" : UnityEngine.Localization.Settings.LocalizationSettings.StringDatabase.GetLocalizedString(value.TableReference,value.TableEntryReference,new UnityEngine.Localization.Locale { Code=locale }); return text.StartsWith("No translation") ? fallback : text; } }
    public static class LocalizationTableAuthorityReferenceUtility
    {
        public static bool TryGetLocaleText(string table,string key,string locale,out string value) { value=UnityEngine.Localization.Settings.LocalizationSettings.StringDatabase.GetLocalizedString(new UnityEngine.Localization.Tables.TableReference{TableCollectionName=table},new UnityEngine.Localization.Tables.TableEntryReference{Key=key},new UnityEngine.Localization.Locale{Code=locale}); return !value.StartsWith("No translation"); }
    }
}
namespace HappyHotel.Card.Templates
{
    public class CardTemplate : UnityEngine.Object { public virtual string LocalizationSystemPrefix => "Card"; public string localizationSlug; public UnityEngine.Localization.LocalizedString itemNameLocalized; }
    public class EquipmentTemplate : CardTemplate { public override string LocalizationSystemPrefix => "Equipment"; }
}
namespace HappyHotel.Card
{
    public class CardIndex { public string TypeId; public Templates.EquipmentTemplate template; }
    public class CardRegistry
    {
        public static CardRegistry Instance { get; } = new CardRegistry();
        public List<CardIndex> Entries = new List<CardIndex> {
            new CardIndex {TypeId="Equipment01",template=new Templates.EquipmentTemplate{name="Equipment01",localizationSlug="equipment-01",itemNameLocalized=new UnityEngine.Localization.LocalizedString{TableReference=new UnityEngine.Localization.Tables.TableReference{TableCollectionName="ItemNames"},TableEntryReference=new UnityEngine.Localization.Tables.TableEntryReference{Key="Equipment/equipment-01/Name"}}}},
            new CardIndex {TypeId="Equipment02",template=new Templates.EquipmentTemplate{name="ArmillaLegioXVIII Template"}}
        };
        public void Initialize() {} public List<CardIndex> GetAllIndexEntries()=>Entries;
        public string GetType(string id)=>id; public CardIndex GetIndexEntry(string id)=>Entries.Find(e=>e.TypeId==id);
    }
    public class EquipmentCard { public string TypeId="Equipment01"; public Templates.EquipmentTemplate Template=>CardRegistry.Instance.Entries[0].template; public bool Bound=true; }
}
namespace HappyHotel.Core.Grid.Components {
    public class GridObjectComponent {
        public UnityEngine.Vector2Int Point; public UnityEngine.Vector2Int Size = new UnityEngine.Vector2Int(1, 1);
        public UnityEngine.Vector2Int GetGridPosition()=>Point; public UnityEngine.Vector2Int GetSize()=>Size;
        public IEnumerable<UnityEngine.Vector2Int> GetOccupiedCells(UnityEngine.Vector2Int origin) {
            for (var x=0;x<Size.x;x++) for(var y=0;y<Size.y;y++) yield return new UnityEngine.Vector2Int(origin.x+x,origin.y+y);
        }
    }
    public class AutoMoveComponent { public bool IsVisualInterpolating; }
}
namespace HappyHotel.Prop
{
    public class PropBase : UnityEngine.Component {}
    public class EquipmentPropBase : PropBase
    {
        public HappyHotel.Card.EquipmentCard Source; public string TypeId="Equipment01"; public bool Removed;
        public HappyHotel.Core.Grid.Components.GridObjectComponent Grid=new HappyHotel.Core.Grid.Components.GridObjectComponent{Point=new UnityEngine.Vector2Int(-2,1)};
        public HappyHotel.Card.EquipmentCard GetSourceEquipment()=>Source;
        public T GetBehaviorComponent<T>() where T:class => Grid as T;
        public new UnityEngine.Component GetComponent(Type type)=>type==typeof(HappyHotel.Prop.PropVisualController) ? new HappyHotel.Prop.PropVisualController{IsDisappearPlaying=Removed} : null;
    }
}
namespace HappyHotel.Prop
{
    public class PropVisualController : UnityEngine.Component { public bool IsDisappearPlaying; }
    public class PropController
    {
        public static PropController Instance { get; private set; }=new PropController();
        public static void Reset() { Instance=new PropController(); }
        public List<EquipmentPropBase> Props=new List<EquipmentPropBase>{ new EquipmentPropBase{TypeId="DifferentPropType",Source=new HappyHotel.Card.EquipmentCard()}, new EquipmentPropBase(), new EquipmentPropBase{Removed=true}, new EquipmentPropBase{Source=new HappyHotel.Card.EquipmentCard{Bound=false}} };
        public List<T> GetAllPropsOfType<T>() where T:PropBase =>Props.OfType<T>().ToList();
    }
}
namespace HappyHotel.Inventory { public class EquipmentCardDeploymentService { public static EquipmentCardDeploymentService Instance {get;}=new EquipmentCardDeploymentService(); public bool IsBound(HappyHotel.Card.EquipmentCard card)=>card.Bound; } }
namespace HappyHotel.Character {
    public class MainCharacter : UnityEngine.Component {
        public string CharacterId="MainCharacter";
        public Core.Grid.Components.GridObjectComponent Grid = new Core.Grid.Components.GridObjectComponent();
        public Core.Grid.Components.AutoMoveComponent Auto = new Core.Grid.Components.AutoMoveComponent();
        public Components.MainCharacterRelocationComponent Relocation;
        public MainCharacter() { Relocation = new Components.MainCharacterRelocationComponent(this); }
        public T GetBehaviorComponent<T>() where T:class => Grid as T ?? Auto as T ?? Relocation as T;
    }
    public class CharacterController { public static CharacterController Instance{get;}=new CharacterController(); public MainCharacter Player = new MainCharacter(); public object[] GetAllCharacters()=>new object[]{Player}; }
}
