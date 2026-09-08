import type { QaBattleSnapshot, QaCatalog, QaCard } from '@shared/contracts'

const cards: QaCard[] = [
  {
    typeId: 'Greatsword',
    name: '双手巨剑',
    description: '部署后提高接触攻击的基础伤害。装备卡抽到时直接进入在场区。',
    category: 'equipment',
    cost: 0,
    rarity: 'common',
    tags: ['武器', '攻击'],
    frameVariant: 0
  },
  {
    typeId: 'StoneArrow',
    name: '石制箭矢',
    description: '向选定方向发射箭矢，对命中的第一个敌人造成伤害。',
    category: 'directional',
    cost: 1,
    rarity: 'common',
    tags: ['投射物'],
    frameVariant: 0
  },
  {
    typeId: 'IronArrow',
    name: '铁制箭矢',
    description: '发射一支穿透力更强的箭矢，对路径上的目标造成伤害。',
    category: 'directional',
    cost: 2,
    rarity: 'rare',
    tags: ['投射物', '攻击'],
    frameVariant: 1
  },
  {
    typeId: 'PotionOfFortitude',
    name: '坚韧药剂',
    description: '恢复生命并在本轮获得临时护甲。',
    category: 'effect',
    cost: 1,
    rarity: 'rare',
    tags: ['恢复'],
    frameVariant: 1
  },
  {
    typeId: 'FireWithinTheShell',
    name: '甲胄之火',
    description: '选择一个目标，使其护甲转化为本轮攻击力。',
    category: 'target',
    cost: 2,
    rarity: 'epic',
    tags: ['护甲', '攻击'],
    frameVariant: 2
  },
  {
    typeId: 'WhispersOfTheForest',
    name: '林间低语',
    description: '在选定格放置一个持续生效的战场装置。',
    category: 'placement',
    cost: 2,
    rarity: 'epic',
    tags: ['装置'],
    frameVariant: 2
  },
  {
    typeId: 'RammingPauldrons',
    name: '冲阵肩甲',
    description: '移动结束时，根据本次移动距离提高下一次接触攻击。',
    category: 'equipment',
    cost: 0,
    rarity: 'legendary',
    tags: ['护甲', '移动'],
    frameVariant: 3
  },
  {
    typeId: 'OilOfMoltenFury',
    name: '熔怒刀油',
    description: '选择一件武器，在本场战斗中提高它的攻击倍率。',
    category: 'target',
    cost: 3,
    rarity: 'legendary',
    tags: ['强化', '武器'],
    frameVariant: 3
  },
  {
    typeId: 'GuardCharm',
    name: '守护护符',
    description: '部署后，每次受到攻击前获得少量护甲。',
    category: 'equipment',
    cost: 0,
    rarity: 'rare',
    tags: ['护甲'],
    frameVariant: 1
  },
  {
    typeId: 'TravelersBackpack',
    name: '旅者背包',
    description: '提高最大费用，并在战斗开始时额外抽取一张卡。',
    category: 'equipment',
    cost: 0,
    rarity: 'epic',
    tags: ['费用', '抽牌'],
    frameVariant: 2
  },
  {
    typeId: 'FerroIgnarium',
    name: '燃铁',
    description: '放置后对进入该格的第一个敌人造成伤害并移除自身。',
    category: 'placement',
    cost: 1,
    rarity: 'common',
    tags: ['陷阱'],
    frameVariant: 0
  },
  {
    typeId: 'CarSiderumCadentium',
    name: '坠星之车',
    description: '改变移动方向并覆盖当前移动距离。',
    category: 'directional',
    cost: 3,
    rarity: 'legendary',
    tags: ['移动', '转向'],
    frameVariant: 3
  }
]

export const demoCatalog: QaCatalog = {
  cards,
  equipment: [
    { typeId: 'Greatsword', name: '双手巨剑' },
    { typeId: 'GuardCharm', name: '守护护符' },
    { typeId: 'RammingPauldrons', name: '冲阵肩甲' },
    { typeId: 'TravelersBackpack', name: '旅者背包' }
  ],
  buffs: [
    { typeId: 'Poison', name: '中毒', description: '回合结束时受到伤害。', supportsStacks: true, supportsDuration: true },
    { typeId: 'Vulnerable', name: '易伤', description: '受到的伤害提高。', supportsStacks: true, supportsDuration: false },
    { typeId: 'Armor', name: '护甲', description: '抵消即将受到的伤害。', supportsStacks: true, supportsDuration: false },
    { typeId: 'Invincible', name: '无敌', description: '暂时免疫伤害。', supportsStacks: false, supportsDuration: true }
  ],
  blessings: [
    { typeId: 'BattleFervor', name: '战斗狂热', description: '连续攻击时逐步提高伤害。' },
    { typeId: 'LastStand', name: '背水一战', description: '生命较低时获得额外护甲。' },
    { typeId: 'CostOverflow', name: '费用溢流', description: '将溢出的费用转化为收益。' }
  ],
  intents: [
    { typeId: 'MoveToMain', name: '接近玩家', description: '向玩家所在方向移动。', parameters: ['distance'] },
    { typeId: 'AttackMain', name: '攻击玩家', description: '对玩家造成伤害。', parameters: ['damage'] },
    { typeId: 'ApplyPoison', name: '施加中毒', description: '为玩家施加中毒。', parameters: ['stacks', 'duration'] },
    { typeId: 'Wait', name: '等待', description: '跳过指定回合。', parameters: ['turns'] }
  ]
}

export const demoBattle: QaBattleSnapshot = {
  available: true,
  sceneName: 'GameScene',
  mapName: 'RomanArena_01',
  width: 9,
  height: 9,
  turn: 3,
  phase: '玩家行动',
  player: {
    instanceId: 'player-main',
    name: '主角',
    position: { x: -3, y: 1 },
    currentHp: 67,
    maxHp: 80,
    currentCost: 3,
    maxCost: 5,
    shield: 6,
    baseAttack: 7,
    attack: 10,
    gold: 128,
    blessings: [
      { typeId: 'BattleFervor', name: '战斗狂热', description: '连续攻击时逐步提高伤害。' },
      { typeId: 'LastStand', name: '背水一战', description: '生命较低时获得额外护甲。' }
    ],
    buffs: [
      { instanceId: 'buff-player-armor', typeId: 'Armor', name: '护甲', stacks: 6, description: '抵消即将受到的伤害。' }
    ]
  },
  entities: [
    {
      instanceId: 'enemy-01#0',
      typeId: 'Enemy01',
      name: '角盔守卫',
      kind: 'enemy',
      position: { x: 0, y: 2 },
      currentHp: 15,
      maxHp: 15,
      baseAttack: 4,
      attack: 6,
      buffs: [],
      loopStartIndex: 0,
      intents: [
        { instanceId: 'intent-a', typeId: 'MoveToMain', name: '接近玩家', summary: '移动 1 格', parameters: { distance: 1 } },
        { instanceId: 'intent-b', typeId: 'AttackMain', name: '攻击玩家', summary: '造成 6 点伤害', parameters: { damage: 6 } }
      ]
    },
    {
      instanceId: 'enemy-01#1',
      typeId: 'Enemy01',
      name: '角盔守卫',
      kind: 'enemy',
      position: { x: 3, y: -1 },
      currentHp: 16,
      maxHp: 16,
      baseAttack: 3,
      attack: 5,
      buffs: [
        { instanceId: 'buff-enemy-poison', typeId: 'Poison', name: '中毒', stacks: 2, remainingTurns: 2, description: '回合结束时受到伤害。' }
      ],
      loopStartIndex: 1,
      intents: [
        { instanceId: 'intent-c', typeId: 'Wait', name: '等待', summary: '等待 1 回合', parameters: { turns: 1 } },
        { instanceId: 'intent-d', typeId: 'ApplyPoison', name: '施加中毒', summary: '施加 2 层中毒', parameters: { stacks: 2, duration: 2 } }
      ]
    },
    {
      instanceId: 'equipment-guard',
      typeId: 'GuardCharm',
      name: '守护护符',
      kind: 'equipment',
      position: { x: 1, y: 0 },
      buffs: []
    }
  ],
  routePreview: {
    startPosition: { x: -3, y: 1 },
    steps: [{ x: -2, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }],
    hasLoop: false,
    hasTerminalPosition: true,
    terminalPosition: { x: -1, y: 0 },
    stopReason: 'MovementExhausted'
  }
}
