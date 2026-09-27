// Heuristic pre-ranking + diversity selection before the LLM step.
const KW = {
  ai: /AI|A\.I\.|人工智能|大模型|模型|智能体|Agent|算力|芯片|GPU|TPU|OpenAI|Anthropic|DeepSeek|千问|Qwen|Kimi|豆包|Gemini|机器人|具身|推理|训练|开源|多模态|英伟达|NVIDIA/gi,
  policy: /国务院|中共中央|通知|意见|办法|条例|规划|方案|政策|财政|税|补贴|发改|改革|监管|规定|实施|标准|国家/g,
  energy: /储能|新能源|光伏|风电|电池|锂|钠|氢|电网|电力|充电|换电|虚拟电厂|绿电|绿证|碳|核电|能源|电站|并网|装机|构网|PCS|电价/g,
};
const JUNK = /广告|推广|赞助|招聘|报名|直播预告|征集|抽奖|优惠|促销|八卦|明星|综艺|电影|电视剧|票房|星座|网红|恋情|离婚|邀请函|会议通知|招商|开幕在即|倒计时|签到|课程|培训班/;
const DIGEST = /早报|晚报|日报|周报|快讯汇总|一周/;
const SOURCE_W = {
  中国政府网: 3, 国家发展改革委: 2.5, 财政部: 2.2, 国家能源局: 2.5, 政策补贴宝: 1,
  钛媒体AGI: 1.5, Aibase基地: 1.5, 中国储能网: 1.6, '36氪': 1.2,
};

export function score(item, domain) {
  const t = item.title || '';
  const d = item.desc || '';
  let s = SOURCE_W[item.source] || 1;
  const hitsT = (t.match(KW[domain]) || []).length;
  const hitsD = (d.match(KW[domain]) || []).length;
  s += Math.min(hitsT, 3) * 1.5 + Math.min(hitsD, 3) * 0.5;
  if (hitsT + hitsD === 0) s -= domain === 'policy' ? 1 : 4; // off-topic (36kr full-text search noise etc.)
  if (JUNK.test(t)) s -= 6;
  if (DIGEST.test(t)) s -= 0.8;
  if (/(取得|获得|申请).{0,30}专利/.test(t)) s -= 3.5; // auto-generated patent filler
  if (item.pv) s += Math.min(2, Math.log10(item.pv + 1) / 3);
  if (t.length < 8) s -= 2;
  return s;
}

function normTitle(t) {
  return String(t || '').replace(/[\s\p{P}]/gu, '').slice(0, 24);
}

/** Dedup + score + diversity pick. Returns the candidate pool (sorted best-first). */
export function selectCandidates(items, domain, n = 12) {
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    const k1 = it.url;
    const k2 = normTitle(it.title);
    if (!it.title || !it.url || seen.has(k1) || seen.has(k2)) continue;
    seen.add(k1);
    seen.add(k2);
    uniq.push({ ...it, _score: score(it, domain) });
  }
  uniq.sort((a, b) => b._score - a._score || b.date.localeCompare(a.date));
  const bySource = {};
  const byDate = {};
  const pool = [];
  const rest = [];
  for (const it of uniq) {
    if (it._score < -2) continue;
    const ps = (bySource[it.source] || 0) * 1.2 + (byDate[it.date] || 0) * 0.6;
    it._adj = it._score - ps;
    rest.push(it);
  }
  // greedy with diminishing returns per source/date
  while (pool.length < n && rest.length) {
    for (const it of rest) it._adj = it._score - (bySource[it.source] || 0) * 2 - (byDate[it.date] || 0) * 1;
    rest.sort((a, b) => b._adj - a._adj);
    const it = rest.shift();
    pool.push(it);
    bySource[it.source] = (bySource[it.source] || 0) + 1;
    byDate[it.date] = (byDate[it.date] || 0) + 1;
  }
  return pool;
}
