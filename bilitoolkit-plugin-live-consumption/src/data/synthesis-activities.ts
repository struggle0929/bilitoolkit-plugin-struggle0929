// Rule snapshot from B瓜's public configuration, retrieved 2026-10-22.
// https://bili-bili.icu/api/config — not an official synthesis ledger.
// Kept locally: the plugin never sends account data or Cookie to that service.
import type { SynthesisActivity } from '../services/synthesis-options.js'

export const synthesisActivities: SynthesisActivity[] = [
  {
    id: '秋日工坊',
    name: '秋日工坊',
    materials: ['替换信物', '抽取信物'],
    products: ['露盏', '桂酿', '扇底清秋', '临水听琴', '兰亭雅宴', '满庭秋华'],
  },
  {
    id: '同行航线',
    name: '同行航线',
    materials: ['召唤岛屿'],
    products: ['启舵之章', '轻舟启航', '星与星愿', '鸥影逐汐', '逐风同游', '浪与远征', '云岛栖梦', '星海领航'],
  },
  {
    id: '合成波仔',
    name: '合成波仔',
    materials: ['玲珑宝斋-布袋', '玲珑宝斋-行囊', '玲珑宝斋-荷包', '玲珑宝斋-背包', '玲珑宝斋-宝箱'],
    products: ['荷间蛙迹', '王子留影', '百宝荷包', '荷叶行宫', '王子驾到'],
  },
  {
    id: '双生秘宝',
    name: '双生秘宝',
    materials: ['国庆双生秘宝-荧尘玦', '国庆双生秘宝-清辉玉璋', '国庆双生秘宝-星枢神戈', '国庆双生秘宝-沧月神玺'],
    products: ['荧尘玦', '清辉玉璋', '星枢神戈', '沧月神玺'],
  },
  {
    id: '团圆工坊',
    name: '团圆工坊',
    materials: ['抽取星石', '替换星石'],
    products: ['流星碎片', '月球之尘', '行星微光', '恒星之炎', '星云秘宝', '黑洞核心'],
  },
  {
    id: '玲珑宝斋',
    name: '玲珑宝斋',
    materials: ['玲珑宝斋-锦囊', '玲珑宝斋-瓷瓶', '玲珑宝斋-银盒', '玲珑宝斋-云锦', '玲珑宝斋-玉函'],
    products: ['相识玉扣', '常伴珠钗', '缘起瓷瓶', '倾心宝冠', '万象天衣'],
    startTime: 1787500800,
    endTime: 1788192000,
  },
  {
    id: '仲夏卡牌',
    name: '仲夏卡牌',
    materials: ['仲夏卡牌_翻牌'],
    products: ['荔枝沙冰', '月夜清荷', '清溪鱼戏', '萤光枕梦', '云屿栖风', '盛夏鎏光'],
  },
  {
    id: '成名之路',
    name: '成名之路',
    materials: ['成名之路'],
    products: ['深夜街角', '灯火小馆', '聚光灯下', '万人合唱', '环球巡演'],
  },
  {
    id: '星座回响',
    name: '星座回响',
    materials: ['召唤星座'],
    products: ['初遇引星', '驻听星语', '并蒂双星', '欢跃星阵', '引路同星', '守护星盾', '星烙徽印', '长明星河'],
  },
  {
    id: '幻灵契约卡牌',
    name: '幻灵契约卡牌',
    materials: ['仲夏卡牌_翻牌'],
    products: ['初遇灵石', '炎纹玄锁', '五彩丹元', '金潮灵浪', '冥钟引籁', '冰澜寒境', '虚天鼎曜'],
    startTime: 1789488000,
    endTime: 1790006400,
  },
]
