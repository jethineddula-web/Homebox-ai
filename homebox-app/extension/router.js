// Homebox extension — picks which AI chat site gets a task typed outside an AI tab.
// Shared by the background worker (importScripts) and the popup (<script>). No network, no storage here.
(function (root) {
  const SITES = [
    { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', hosts: ['chatgpt.com', 'chat.openai.com'] },
    { id: 'claude', name: 'Claude', url: 'https://claude.ai/new', hosts: ['claude.ai'] },
    { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app', hosts: ['gemini.google.com'] },
    { id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/', hosts: ['perplexity.ai', 'www.perplexity.ai'] },
    { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', hosts: ['chat.deepseek.com'] },
    { id: 'grok', name: 'Grok', url: 'https://grok.com/', hosts: ['grok.com'] },
    { id: 'mistral', name: 'Mistral', url: 'https://chat.mistral.ai/chat', hosts: ['chat.mistral.ai'] },
    { id: 'qwen', name: 'Qwen', url: 'https://chat.qwen.ai/', hosts: ['chat.qwen.ai'] },
    { id: 'copilot', name: 'Copilot', url: 'https://copilot.microsoft.com/', hosts: ['copilot.microsoft.com'] },
    { id: 'arena', name: 'Arena', url: 'https://arena.ai/', hosts: ['arena.ai', 'lmarena.ai'] },
  ];

  // Starting points, not a ranking anyone can prove: the user can pick a different first choice for each kind.
  const KINDS = {
    build: { label: 'Computer tasks (code, files, apps, tabs)', order: ['claude', 'chatgpt', 'gemini', 'deepseek', 'qwen', 'grok', 'mistral', 'copilot', 'perplexity', 'arena'] },
    hard: { label: 'Hard thinking', order: ['chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'qwen', 'mistral', 'copilot', 'perplexity', 'arena'] },
    research: { label: 'Research and latest news', order: ['perplexity', 'gemini', 'chatgpt', 'grok', 'copilot', 'claude', 'deepseek', 'mistral', 'qwen', 'arena'] },
    writing: { label: 'Writing', order: ['claude', 'chatgpt', 'gemini', 'mistral', 'deepseek', 'grok', 'copilot', 'qwen', 'perplexity', 'arena'] },
    quick: { label: 'Quick question', order: ['chatgpt', 'gemini', 'claude', 'copilot', 'perplexity', 'deepseek', 'grok', 'mistral', 'qwen', 'arena'] },
  };

  const NAMES = { chatgpt: 'chatgpt|chat ?gpt|gpt', claude: 'claude', gemini: 'gemini|bard', perplexity: 'perplexity', deepseek: 'deep ?seek', grok: 'grok', mistral: 'mistral|le chat', qwen: 'qwen', copilot: 'copilot', arena: '(?:lm ?)?arena' };
  const NAMED = new RegExp(`\\b(?:use|using|on|with|in|via|switch to|ask|open)\\s+(${Object.values(NAMES).join('|')})\\b`, 'i');

  // Needs Homebox's tools (files, apps, browser tabs) rather than just an answer in the chat.
  const COMPUTER = /\b(my (computer|pc|folder|files?|desktop|cv|resume|github|tabs?)|ai folder|folder|files?|save (it|this|them)|build (a|an|me|my)|make (a|an|me|my) (website|web ?site|app|game|tool|script|program|spreadsheet|presentation|document|page|bot)|website|web app|script|repo(sitory)?|github|code|bug|error|fix (my|the|this)|maya|blender|houdini|3ds ?max|cinema ?4d|nuke|unreal|photoshop|illustrator|after effects|excel|spreadsheet|powerpoint|word document|autocad|obs|vs ?code|tabs?|form|apply (for|to)|job application|gmail|email draft|send (an|a) email|play (a|the)? ?game|chess|wordle|sudoku|scroll(ing)?|swipe|youtube|shorts|reels|this (page|tab|site|video)|click|browser)\b/i;
  const BUILD = /\b(code|coding|program|script|website|web ?site|web app|app|api|bug|error|debug|refactor|function|github|repo|python|javascript|html|css|react|maya|blender|houdini|unreal|vs ?code|rig|shader|plugin|automate)\b/i;
  const RESEARCH = /\b(latest|today|tonight|this week|news|current(ly)?|right now|20[2-3]\d|price|prices|cost of|compare|comparison|research|sources?|citations?|look up|search (for|the web)|who won|weather|stock|review(s)? of|best .* to buy)\b/i;
  const WRITING = /\b(write|rewrite|draft|email|letter|cover letter|essay|blog|post|caption|bio|linkedin|resume|cv|proofread|summari[sz]e|translate|poem|story|speech|message to)\b/i;
  const HARD = /\b(plan|strategy|analy[sz]e|analysis|prove|proof|math|calculate|equation|step by step|design|architecture|optimi[sz]e|trade-?offs?|why does|explain in detail|business plan|complex)\b/i;

  function classify(text) {
    const t = String(text || '');
    const words = t.trim().split(/\s+/).filter(Boolean).length;
    const named = (t.match(NAMED) || [])[1];
    const site = named ? Object.keys(NAMES).find(id => new RegExp(`^(${NAMES[id]})$`, 'i').test(named)) : null;
    const computer = COMPUTER.test(t);
    let kind, why;
    if (computer && BUILD.test(t)) { kind = 'build'; why = 'it builds or changes code and files'; }
    else if (RESEARCH.test(t)) { kind = 'research'; why = 'it needs up-to-date information'; }
    else if (WRITING.test(t)) { kind = 'writing'; why = 'it is mostly writing'; }
    else if (computer) { kind = 'build'; why = 'it works with your files and apps'; }
    else if (HARD.test(t) || words > 80) { kind = 'hard'; why = 'it needs careful thinking'; }
    else { kind = 'quick'; why = 'it is a quick question'; }
    return { kind, label: KINDS[kind].label, why, computer, named: site };
  }

  // prefs: { first: { build: 'claude', … }, skip: ['grok', …] }
  function order(kind, prefs = {}) {
    const base = KINDS[kind] ? KINDS[kind].order : KINDS.quick.order;
    const first = prefs.first && prefs.first[kind];
    const skip = new Set(prefs.skip || []);
    const list = first ? [first, ...base.filter(id => id !== first)] : base.slice();
    const kept = list.filter(id => !skip.has(id) && SITES.some(s => s.id === id));
    return kept.length ? kept : base.slice();
  }

  // The full plan for a task: which site first, the backups, and why.
  function plan(text, prefs = {}, forced = '') {
    const c = classify(text);
    let list = order(c.kind, prefs);
    const pick = forced || c.named;
    if (pick && SITES.some(s => s.id === pick)) list = [pick, ...list.filter(id => id !== pick)];
    const first = SITES.find(s => s.id === list[0]);
    const reason = forced ? `you chose ${first.name}` : c.named ? `you asked for ${first.name}` : `${c.label.toLowerCase()}: ${c.why}`;
    return { ...c, order: list, site: first, reason };
  }

  const byId = id => SITES.find(s => s.id === id) || null;
  const byHost = host => { host = String(host || '').replace(/^www\./, ''); return SITES.find(s => s.hosts.some(h => h.replace(/^www\./, '') === host)) || null; };

  root.HB_ROUTER = { SITES, KINDS, classify, order, plan, byId, byHost };
})(typeof self !== 'undefined' ? self : globalThis);
