"""Execution-validated architecture tasks — the seed corpus.

Each task ships a reference solution and a pytest-style assertion script.
The pipeline only keeps a pair if the code actually runs.
"""

from __future__ import annotations

TASKS: list[dict] = [
    {
        "id": "chunk_text",
        "instruction": "Write chunk_text(text, size=400) that splits on whitespace into chunks of at most `size` words without dropping tokens.",
        "code": "def chunk_text(text, size=400):\n    words = text.split()\n    if not words:\n        return [text] if text == '' else []\n    return [' '.join(words[i:i+size]) for i in range(0, len(words), size)]\n",
        "tests": "c = chunk_text(' '.join(['w']*850), 400)\nassert len(c)==3 and len(c[0].split())==400 and len(c[2].split())==50\nassert chunk_text('')==[''] or chunk_text('')==[]\n",
    },
    {
        "id": "tenant_predicate",
        "instruction": "Write tenant_ok(row, tenant_id) that returns True only when row['tenant_id'] equals tenant_id (string-safe).",
        "code": "def tenant_ok(row, tenant_id):\n    return str(row.get('tenant_id')) == str(tenant_id)\n",
        "tests": "assert tenant_ok({'tenant_id':'t1'}, 't1')\nassert not tenant_ok({'tenant_id':'t2'}, 't1')\nassert tenant_ok({'tenant_id': 7}, '7')\n",
    },
    {
        "id": "score_branch",
        "instruction": "Write score_branch(correctness, completeness, efficiency) = 0.45c + 0.35m + 0.20e, each input clamped to [0,1].",
        "code": "def score_branch(correctness, completeness, efficiency):\n    def clamp(x):\n        return max(0.0, min(1.0, float(x)))\n    c, m, e = clamp(correctness), clamp(completeness), clamp(efficiency)\n    return 0.45*c + 0.35*m + 0.20*e\n",
        "tests": "s = score_branch(1,1,1)\nassert abs(s-1)<1e-9\nassert 0 <= score_branch(2, -1, 0.5) <= 1\n",
    },
    {
        "id": "prune_weakest",
        "instruction": "Write prune_weakest(branches) where each branch is {id, score}. Mark the lowest score with pruned=True, others False. Return a new list.",
        "code": "def prune_weakest(branches):\n    if not branches:\n        return []\n    worst_id = min(branches, key=lambda b: b['score'])['id']\n    out = []\n    seen = False\n    for b in branches:\n        d = dict(b)\n        if b['id'] == worst_id and not seen:\n            d['pruned'] = True\n            seen = True\n        else:\n            d['pruned'] = False\n        out.append(d)\n    return out\n",
        "tests": "r = prune_weakest([{'id':'A','score':0.9},{'id':'B','score':0.2},{'id':'C','score':0.7}])\nassert sum(1 for x in r if x['pruned'])==1\nassert next(x['id'] for x in r if x['pruned'])=='B'\n",
    },
    {
        "id": "sliding_window",
        "instruction": "Write class ShortTerm(max_items=12) with add(item) and items() returning the most recent max_items in order.",
        "code": "class ShortTerm:\n    def __init__(self, max_items=12):\n        self.max_items = max_items\n        self._buf = []\n    def add(self, item):\n        self._buf.append(item)\n        if len(self._buf) > self.max_items:\n            self._buf = self._buf[-self.max_items:]\n    def items(self):\n        return list(self._buf)\n",
        "tests": "s=ShortTerm(3)\nfor i in range(5): s.add(i)\nassert s.items()==[2,3,4]\n",
    },
    {
        "id": "tfidf_overlap",
        "instruction": "Write lexical_score(query, doc) as |intersection of word sets| / |query words|, lowercase, words len>2. Empty query -> 0.",
        "code": "def lexical_score(query, doc):\n    q = {w for w in query.lower().split() if len(w)>2}\n    if not q: return 0.0\n    d = {w for w in doc.lower().split() if len(w)>2}\n    return len(q & d) / len(q)\n",
        "tests": "assert lexical_score('tree of thought','thought tree search')==1.0\nassert lexical_score('','x')==0.0\nassert 0 < lexical_score('agent memory store','memory layer') < 1\n",
    },
    {
        "id": "rate_window",
        "instruction": "Write allow(timestamps, now, limit, window_s) — True if number of timestamps in (now-window_s, now] is < limit. timestamps are unix seconds.",
        "code": "def allow(timestamps, now, limit, window_s):\n    n = sum(1 for t in timestamps if now - window_s < t <= now)\n    return n < limit\n",
        "tests": "assert allow([1,2,3], 5, 3, 10) is False\nassert allow([1], 50, 3, 10) is True\n",
    },
    {
        "id": "json_extract",
        "instruction": "Write extract_json_object(text) that returns the first {...} substring parsed as dict. Raise ValueError if none.",
        "code": "import json\ndef extract_json_object(text):\n    s, e = text.find('{'), text.rfind('}')\n    if s<0 or e<=s: raise ValueError('no object')\n    return json.loads(text[s:e+1])\n",
        "tests": "assert extract_json_object('x {\"a\":1} y')['a']==1\ntry:\n    extract_json_object('nope')\n    raise SystemExit('should fail')\nexcept ValueError:\n    pass\n",
    },
    {
        "id": "bos_pack",
        "instruction": "Write pack_ids(ids, seq_len, pad=0) — pad or truncate to seq_len, returning exactly seq_len ints.",
        "code": "def pack_ids(ids, seq_len, pad=0):\n    ids = list(ids)[:seq_len]\n    if len(ids) < seq_len:\n        ids = ids + [pad]*(seq_len-len(ids))\n    return ids\n",
        "tests": "assert pack_ids([1,2], 4)==[1,2,0,0]\nassert pack_ids(range(10), 4)==[0,1,2,3] or pack_ids(list(range(10)),4)==[0,1,2,3]\n",
    },
    {
        "id": "gqa_repeat",
        "instruction": "Write repeat_kv(n_heads, n_kv) -> n_rep = n_heads // n_kv. Raise ValueError if not divisible.",
        "code": "def repeat_kv(n_heads, n_kv):\n    if n_kv<=0 or n_heads % n_kv != 0:\n        raise ValueError('gqa')\n    return n_heads // n_kv\n",
        "tests": "assert repeat_kv(8,2)==4\ntry:\n    repeat_kv(8,3)\n    raise SystemExit('bad')\nexcept ValueError:\n    pass\n",
    },
    {
        "id": "hmac_equal",
        "instruction": "Write token_eq(a, b) using hmac.compare_digest on utf-8 bytes so it is timing-safe.",
        "code": "import hmac\ndef token_eq(a, b):\n    return hmac.compare_digest(str(a).encode(), str(b).encode())\n",
        "tests": "assert token_eq('abc','abc')\nassert not token_eq('abc','ab')\n",
    },
    {
        "id": "path_safe",
        "instruction": "Write safe_join(root, name) that joins and rejects paths escaping root via .. . Raise ValueError on escape.",
        "code": "import os\ndef safe_join(root, name):\n    root = os.path.abspath(root)\n    path = os.path.abspath(os.path.join(root, name))\n    if path==root or path.startswith(root + os.sep):\n        return path\n    raise ValueError('escape')\n",
        "tests": "import tempfile, os\ntd=tempfile.mkdtemp()\nassert safe_join(td,'a.txt').startswith(td)\ntry:\n    safe_join(td,'../x')\n    raise SystemExit('esc')\nexcept ValueError:\n    pass\n",
    },
    {
        "id": "sse_frame",
        "instruction": "Write sse_data(obj) that returns 'data: {json}\\n\\n' with compact JSON.",
        "code": "import json\ndef sse_data(obj):\n    return 'data: ' + json.dumps(obj, separators=(',', ':')) + '\\n\\n'\n",
        "tests": "s=sse_data({'a':1})\nassert s.startswith('data: {') and s.endswith('\\n\\n')\n",
    },
    {
        "id": "title_from",
        "instruction": "Write title_from(text, n=48) collapsing whitespace and adding an ellipsis if longer than n.",
        "code": "def title_from(text, n=48):\n    t=' '.join(text.split()).strip()\n    return t if len(t)<=n else t[:n] + '…'\n",
        "tests": "assert title_from('  hello   world  ')=='hello world'\nassert title_from('x'*60).endswith('…') and len(title_from('x'*60))==61\n",
    },
    {
        "id": "clamp01",
        "instruction": "Write clamp01(x) mapping non-finite to 0 and bounding to [0,1].",
        "code": "import math\ndef clamp01(x):\n    try:\n        v=float(x)\n    except (TypeError, ValueError):\n        return 0.0\n    if not math.isfinite(v): return 0.0\n    return 0.0 if v<0 else 1.0 if v>1 else v\n",
        "tests": "assert clamp01(0.2)==0.2 and clamp01(9)==1 and clamp01(-2)==0\nimport math\nassert clamp01(math.nan)==0\n",
    },
    {
        "id": "dedup_hash",
        "instruction": "Write exact_hash(text) as sha256 hex of utf-8 bytes, used for dataset exact-dedup.",
        "code": "import hashlib\ndef exact_hash(text):\n    return hashlib.sha256(text.encode('utf-8')).hexdigest()\n",
        "tests": "assert exact_hash('a')==exact_hash('a') and exact_hash('a')!=exact_hash('b') and len(exact_hash('a'))==64\n",
    },
    {
        "id": "kv_expand_len",
        "instruction": "Write kv_len(seq, cache_len) -> seq+cache_len for GQA cache concat along sequence.",
        "code": "def kv_len(seq, cache_len):\n    return int(seq)+int(cache_len)\n",
        "tests": "assert kv_len(8,16)==24\n",
    },
    {
        "id": "parse_react",
        "instruction": "Write parse_action(text) extracting the first 'Action: NAME' line's NAME, or None.",
        "code": "import re\ndef parse_action(text):\n    m=re.search(r'^Action:\\s*(\\S+)', text, re.M)\n    return m.group(1) if m else None\n",
        "tests": "assert parse_action('Thought: x\\nAction: search')=='search'\nassert parse_action('nope') is None\n",
    },
    {
        "id": "page_slice",
        "instruction": "Write page(items, offset, limit) returning items[offset:offset+limit] with offset/limit >=0.",
        "code": "def page(items, offset, limit):\n    o=max(0,int(offset)); n=max(0,int(limit))\n    return list(items)[o:o+n]\n",
        "tests": "assert page(range(10), 2, 3)==[2,3,4]\nassert page([1], 5, 2)==[]\n",
    },
    {
        "id": "merge_usage",
        "instruction": "Write merge_usage(a, b) summing prompt_tokens and completion_tokens ints.",
        "code": "def merge_usage(a, b):\n    return {\n        'prompt_tokens': int(a.get('prompt_tokens',0))+int(b.get('prompt_tokens',0)),\n        'completion_tokens': int(a.get('completion_tokens',0))+int(b.get('completion_tokens',0)),\n    }\n",
        "tests": "u=merge_usage({'prompt_tokens':1}, {'prompt_tokens':2,'completion_tokens':3})\nassert u['prompt_tokens']==3 and u['completion_tokens']==3\n",
    },
]

EVOLUTIONS = [
    "Add explicit type hints and a one-line docstring.",
    "Reject invalid inputs with ValueError instead of implicit coercion where it would hide bugs.",
    "Keep the function pure — no globals, no prints.",
]
