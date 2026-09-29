// One LLM call per domain: summary / sentiment / analysis / importance + ad-fluff filter.
// Default: Workers AI binding (env.AI, model env.AI_MODEL). Override: any OpenAI-compatible
// endpoint when secret LLM_API_KEY is set (env.LLM_BASE_URL, env.LLM_MODEL).

const DOMAIN_CN = { ai: 'AI/人工智能', policy: '国家政策', energy: '新能源/储能', custom: '综合资讯（用户自选来源）' };

function buildPrompt(domain, cands, limit) {
  const lines = cands.map((c, i) => `${i}. [${c.date}][${c.source}] ${c.title}${c.desc ? ' —— ' + c.desc.slice(0, 120) : ''}`).join('\n');
  const system =
    '你是严谨的中文产业新闻编辑，只输出JSON，不要输出任何解释或Markdown。';
  const user = `领域：${DOMAIN_CN[domain]}
下面是候选新闻（序号. [日期][来源] 标题 —— 简介）：
${lines}

任务：
1. 剔除广告、软文/水文、会议报名/招商、娱乐八卦${domain === 'custom' ? '' : `、与“${DOMAIN_CN[domain]}”无关`}或无实质内容的条目。
2. 从余下条目中按重要性挑选最多 ${limit} 条；优先有政策/技术/产业实质影响；尽量覆盖不同日期和不同来源（同一来源一般不超过${Math.max(3, Math.ceil(limit * 0.6))}条）。
3. 只为被选中的条目输出：
   - i：候选序号
   - summary：不超过50个汉字的客观摘要（不要编造候选中没有的数字和事实）
   - sentiment：只能是 "利好"、"利空"、"中性" 之一（对相关产业/市场）
   - analysis：不超过40个汉字的影响分析，不要以“利好/利空/中性”开头
   - importance：1-3 的整数，3 最重要
只输出如下紧凑 JSON，不要输出其他内容：
{"items":[{"i":0,"summary":"...","sentiment":"利好","analysis":"...","importance":2}]}`;
  return { system, user };
}

function extractJson(text) {
  if (!text) return null;
  if (typeof text === 'object') return text;
  let s = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

async function withTimeout(p, ms, what) {
  let t;
  const to = new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timeout ${ms}ms`)), ms)));
  try {
    return await Promise.race([p, to]);
  } finally {
    clearTimeout(t);
  }
}

async function callOpenAICompat(env, system, user, ctx) {
  const base = (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  if (ctx) ctx.take();
  const res = await withTimeout(
    fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({
        model: env.LLM_MODEL || 'deepseek-chat',
        temperature: 0.2,
        max_tokens: 1800,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    }),
    Number(env.LLM_TIMEOUT_MS || 25000),
    'LLM'
  );
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return { text: j?.choices?.[0]?.message?.content, model: env.LLM_MODEL || 'deepseek-chat' };
}

async function callWorkersAI(env, system, user) {
  const model = env.AI_MODEL || '@cf/qwen/qwen3-30b-a3b-fp8';
  const out = await withTimeout(
    env.AI.run(model, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 4000,
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
    }),
    Number(env.LLM_TIMEOUT_MS || 25000),
    'Workers AI'
  );
  const msg = out?.choices?.[0]?.message;
  let text = out?.response ?? msg?.content ?? msg?.reasoning_content ?? out?.result?.response ?? out;
  return { text, model };
}

const clip = (s, n) => {
  const a = [...String(s || '').trim()];
  return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join('');
};

/** Returns { items, analyzed, model, error } */
export async function analyze(env, domain, cands, limit, ctx) {
  const fallback = (error) => ({
    analyzed: false,
    error,
    items: cands.slice(0, limit).map((c) => ({ ...c, summary: clip(c.desc || c.title, 50), sentiment: '中性', analysis: '', importance: 1 })),
  });
  if (!cands.length) return { analyzed: false, items: [] };
  const useKey = !!env.LLM_API_KEY;
  if (!useKey && !env.AI) return fallback('no LLM configured');
  const { system, user } = buildPrompt(domain, cands, limit);
  let r;
  let j = null;
  let lastErr = '';
  for (let attempt = 0; attempt < 2 && !j; attempt++) {
    try {
      r = useKey ? await callOpenAICompat(env, system, user, ctx) : await callWorkersAI(env, system, user);
      j = extractJson(r.text);
      if (!j || !Array.isArray(j.items)) {
        j = null;
        lastErr = 'LLM returned non-JSON: ' + String(typeof r.text === 'string' ? r.text : JSON.stringify(r.text)).slice(0, 700);
      }
    } catch (e) {
      lastErr = String(e.message || e).slice(0, 200);
    }
  }
  if (!j) return fallback(lastErr);
  const picked = [];
  for (const x of j.items) {
    const c = cands[Number(x.i)];
    if (!c || !x.summary) continue;
    if (picked.some((p) => p.url === c.url)) continue;
    const sentiment = ['利好', '利空', '中性'].includes(x.sentiment) ? x.sentiment : '中性';
    picked.push({
      ...c,
      summary: clip(x.summary, 50),
      sentiment,
      analysis: clip(String(x.analysis || '').replace(/^(利好|利空|中性)[：:，,\s]*/, ''), 50),
      importance: Math.max(1, Math.min(3, parseInt(x.importance, 10) || 1)),
    });
    if (picked.length >= limit) break;
  }
  return { analyzed: picked.length > 0, model: r.model, items: picked, error: picked.length ? undefined : 'LLM selected nothing' };
}
