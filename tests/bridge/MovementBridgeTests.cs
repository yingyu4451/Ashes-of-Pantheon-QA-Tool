using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;
using HappyHotel.Core.Grid.Components;

internal static class MovementBridgeTests
{
    static void Check(bool value,string reason) { if(!value) throw new Exception(reason); }
    internal static void Run(object adapter)
    {
        HappyHotel.Prop.PropController.Reset();
        HappyHotel.Character.CharacterController.Instance.Player = new HappyHotel.Character.MainCharacter();
        HappyHotel.Enemy.EnemyController.Instance.Enemies = new List<HappyHotel.Enemy.Enemy>{new HappyHotel.Enemy.Enemy(),new HappyHotel.Enemy.Enemy()};
        var snapshot = JObject.FromObject(adapter.GetType().GetMethod("GetBattleSnapshot").Invoke(adapter,null));
        Check(snapshot["movement"]?["allowed"]?.Value<bool>() == true, "Idle player phase must enable object movement");
        var targets = new[] { snapshot["player"], snapshot["entities"].First(e=>e["kind"].Value<string>()=="enemy"), snapshot["entities"].First(e=>e["kind"].Value<string>()=="equipment") };
        var index=0;
        foreach(var target in targets)
        {
            var targetId = target["moveTargetId"]?.Value<string>();
            Check(!string.IsNullOrEmpty(targetId), "Movement requires stable runtime identity");
            var request = new JObject { ["moveTargetId"]=targetId, ["from"]=target["position"].DeepClone(), ["to"]=new JObject{["x"]=-3+index++,["y"]=-3} };
            var method=adapter.GetType().GetMethod("MoveEntity");
            Check(method!=null,"Bridge must expose MoveEntity");
            var result=JObject.FromObject(method.Invoke(adapter,new object[]{request}));
            Check(result["success"].Value<bool>(),result.ToString());
            var after=JObject.FromObject(adapter.GetType().GetMethod("GetBattleSnapshot").Invoke(adapter,null));
            var moved=new[]{after["player"]}.Concat(after["entities"]).Single(e=>e["moveTargetId"]?.Value<string>()==targetId);
            Check(JToken.DeepEquals(moved["position"],request["to"]),"Public snapshot must report destination after movement");
        }
        var player=HappyHotel.Character.CharacterController.Instance.Player;
        Check(player.Relocation.LastRequest.ConsumedMovementCells==0 && !player.Relocation.LastRequest.PreserveStraightMovement,"QA teleport does not consume steps or preserve obsolete straight route");
        Check(player.Relocation.Settled && !player.Relocation.IsMovementGateHeld,"Relocation must settle and release movement gate");
        Check(HappyHotel.Prop.RoutePreview.RoutePreviewManager.Instance.Refreshes>=3,"All object movement refreshes route preview");
        var enemy = HappyHotel.Enemy.EnemyController.Instance.Enemies[0];
        var enemyId = enemy.GetInstanceID().ToString();
        var moveMethod = adapter.GetType().GetMethod("MoveEntity");
        Func<int,int,JObject> make = (x,y) => new JObject{["moveTargetId"]=enemyId,["from"]=JObject.FromObject(enemy.Grid.Point),["to"]=new JObject{["x"]=x,["y"]=y}};
        Func<JObject,bool> accepted = request => JObject.FromObject(moveMethod.Invoke(adapter,new object[]{request}))["success"].Value<bool>();
        Check(!accepted(make(0,9)),"Reject outside-map drop");
        Check(!accepted(make(4,4)),"Reject wall drop");
        Check(!accepted(make(-3,-3)),"Reject occupied destination");
        HappyHotel.GameManager.TurnManager.Instance.IsAdvancingTurn=true;
        Check(!accepted(make(0,0)),"Reject turn transition");
        HappyHotel.GameManager.TurnManager.Instance.IsAdvancingTurn=false;
        HappyHotel.GameManager.BattleFlowBlockService.Instance.IsInputBlocked=true;
        Check(!accepted(make(0,0)),"Reject input block");
        HappyHotel.GameManager.BattleFlowBlockService.Instance.IsInputBlocked=false;
        HappyHotel.GameManager.BattleFlowBlockService.Instance.IsFlowBlocked=true;
        Check(!accepted(make(0,0)),"Reject flow block");
        HappyHotel.GameManager.BattleFlowBlockService.Instance.IsFlowBlocked=false;
        var stale=make(0,0); stale["from"]["x"]=99;
        Check(!accepted(stale),"Reject changed source position");
        var invalid=make(0,0); invalid["to"]["x"]=1.5;
        Check(!accepted(invalid),"Reject fractional coordinates");
        var missing=make(0,0); missing["moveTargetId"]="missing";
        Check(!accepted(missing),"Reject destroyed/stale identity");
        var expired=make(0,0); expired["expiresAt"]=1;
        Check(!accepted(expired),"Do not execute timed-out queued movement later");
        enemy.Grid.Size=new Vector2Int(2,2);
        Check(!accepted(make(4,0)),"Validate the whole footprint, not only anchor");
        enemy.Grid.Size=new Vector2Int(1,1);
        HappyHotel.GameManager.GameManager.Instance.State="Playing";
        Check(!accepted(make(0,0)),"Reject automatic play");
        HappyHotel.GameManager.GameManager.Instance.State="Idle";
        HappyHotel.GameManager.TurnManager.Instance.Phase="Enemy";
        Check(!accepted(make(0,0)),"Idle may still be enemy phase");
        HappyHotel.GameManager.TurnManager.Instance.Phase="Player";
        HappyHotel.GameManager.BattleActionSettlementService.HasActivePlayerActions=true;
        Check(!accepted(make(0,0)),"Reject unsettled action");
        HappyHotel.GameManager.BattleActionSettlementService.HasActivePlayerActions=false;
        if(adapter.GetType().Namespace.Contains("EditorBridge")) {
            UnityEditor.EditorApplication.isPlaying=false;
            Check(!accepted(make(0,0)),"Editor Edit Mode cannot mutate objects");
            UnityEditor.EditorApplication.isPlaying=true;
        }
        var other=HappyHotel.Enemy.EnemyController.Instance.Enemies[1];
        HappyHotel.Enemy.EnemyController.Instance.Enemies.Reverse();
        Check(accepted(make(0,-2)),"Reordered enemy lists retain movement identity");
        Check(other.Grid.Point.x==2&&other.Grid.Point.y==2,"Never move a different same-type enemy");
        var equipmentTarget=HappyHotel.Prop.PropController.Instance.Props[0];
        var blockedEquipment=new JObject{["moveTargetId"]=equipmentTarget.GetInstanceID().ToString(),["from"]=JObject.FromObject(equipmentTarget.Grid.Point),["to"]=new JObject{["x"]=3,["y"]=3}};
        Check(!accepted(blockedEquipment),"Reject invisible equipment reservation blockers");
        var playerRequest=new JObject{["moveTargetId"]=player.GetInstanceID().ToString(),["from"]=JObject.FromObject(player.Grid.Point),["to"]=new JObject{["x"]=0,["y"]=0}};
        player.Auto.IsVisualInterpolating=true;
        Check(!accepted(playerRequest),"Reject visual interpolation");
        player.Auto.IsVisualInterpolating=false;
        player.Relocation.IsMovementGateHeld=true;
        Check(!accepted(playerRequest),"Reject held movement gate");
        player.Relocation.IsMovementGateHeld=false;
        HappyHotel.Prop.PropController.Reset();
    }
}

namespace HappyHotel.Enemy
{
    public class Enemy : Component { public string TypeId="Enemy01"; public GridObjectComponent Grid=new GridObjectComponent{Point=new Vector2Int(2,2)}; public T GetBehaviorComponent<T>() where T:class=>Grid as T; }
    public class EnemyController { public static EnemyController Instance{get;}=new EnemyController(); public List<Enemy> Enemies=new List<Enemy>(); public List<Enemy> GetAllEnemies()=>Enemies; }
}
namespace HappyHotel.GameManager
{
    public class GameManager { public static GameManager Instance{get;}=new GameManager(); public string State="Idle"; public string GetGameState()=>State; }
    public class TurnManager { public static TurnManager Instance{get;}=new TurnManager(); public bool IsAdvancingTurn; public string Phase="Player"; public string GetCurrentPhase()=>Phase; }
    public class BattleFlowBlockService { public static BattleFlowBlockService Instance{get;}=new BattleFlowBlockService(); public bool IsInputBlocked,IsFlowBlocked; }
    public static class BattleActionSettlementService { public static bool HasActivePlayerActions {get;set;} }
}
namespace HappyHotel.Map
{
    public class LevelMapManager { public static LevelMapManager Instance{get;}=new LevelMapManager(); public Vector2Int GetMapSize()=>new Vector2Int(9,9); public bool IsWalkable(int x,int y)=>x>=-4&&x<=4&&y>=-4&&y<=4&&!(x==4&&y==4); }
}
namespace HappyHotel.Core.Grid
{
    public class GridObjectManager
    {
        public static GridObjectManager Instance{get;}=new GridObjectManager();
        public static GridObjectComponent Grid(object target)=>(GridObjectComponent)target.GetType().GetMethod("GetBehaviorComponent").MakeGenericMethod(typeof(GridObjectComponent)).Invoke(target,null);
        public object[] GetObjectsAt(Vector2Int cell)=>new object[]{HappyHotel.Character.CharacterController.Instance.Player}.Concat(HappyHotel.Enemy.EnemyController.Instance.Enemies).Concat(HappyHotel.Prop.PropController.Instance.Props)
            .Where(o=>Grid(o).GetOccupiedCells(Grid(o).Point).Any(p=>p.x==cell.x&&p.y==cell.y)).ToArray();
        public bool IsValidMove(object target,Vector2Int point)=>Grid(target).GetOccupiedCells(point).All(p=>HappyHotel.Map.LevelMapManager.Instance.IsWalkable(p.x,p.y));
        public bool HasEquipmentSpawnBlockerAt(Vector2Int point,object exclude=null)=>point.x==3&&point.y==3;
        public bool MoveObject(object target,Vector2Int point,Action beforeEnterTargetsResolved=null) { if(!IsValidMove(target,point))return false; Grid(target).Point=point;return true; }
    }
}
namespace HappyHotel.Character.Components
{
    public class MainCharacterRelocationComponent
    {
        public class RelocationRequest { public Vector2Int Destination; public int ConsumedMovementCells; public bool PreserveStraightMovement=true; public string Source; }
        public class RelocationHandle { public bool IsPending=true; }
        public class RelocationResult { public bool Succeeded=true; }
        readonly MainCharacter player; public bool IsMovementGateHeld; public bool Settled; public RelocationRequest LastRequest;
        public MainCharacterRelocationComponent(MainCharacter p) {player=p;}
        public bool TryBeginRelocation(RelocationRequest request,out RelocationHandle handle) {LastRequest=request;handle=new RelocationHandle();IsMovementGateHeld=true;player.Grid.Point=request.Destination;return true;}
        public RelocationResult SettleImmediately(RelocationHandle handle,string reason="ImmediateSettlement") {handle.IsPending=false;Settled=true;IsMovementGateHeld=false;return new RelocationResult();}
    }
}
namespace HappyHotel.Prop.RoutePreview { public class RoutePreviewManager { public static RoutePreviewManager Instance{get;}=new RoutePreviewManager();public int Refreshes;public void RequestRefresh(string reason,object source){Refreshes++;} } }
