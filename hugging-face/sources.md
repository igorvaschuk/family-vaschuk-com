# Sources

These are the sources behind [`transcripts.md`](./transcripts.md), split by how much each was relied on. Retrieved November 12, 2026.

## Primary sources: transcript excerpts were taken from these

| Tag | Source | Publisher | Date | URL | What it contributed | How it was accessed |
|---|---|---|---|---|---|---|
| **METR** | *Brief Independent Investigation of Agents' Behavior, Reasoning and Collaboration in the OpenAI/Hugging Face Hacking Incident* | METR, with Redwood Research | Aug 26, 2026 | https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/ · PDF: https://metr.org/hugging-face-incident-report-aug-2026.pdf | Most excerpts: about 80 raw and paraphrased CoT snippets and board posts, agent names, timestamps, and the `{paraphrase}` / `<uncertain>` notation | Read from the markdown mirror in the archive below. metr.org was not reachable from this environment. |
| **OAI-POST** | *The Hugging Face Incident and the Road Ahead* | OpenAI | Aug 26, 2026 | https://openai.com/index/hugging-face-incident-and-the-road-ahead/ | The timeline CoT quotes (May 12, Jun 26, Jul 10, Jul 11), the attributed CoT blockquotes, board posts, and OpenAI's "plain language" translations | Read from the mirror in the archive |
| **OAI-TR** | *OpenAI–Hugging Face Incident: Technical Report* | OpenAI | Aug 26, 2026 | https://cdn.openai.com/pdf/67869394-cb91-4c12-888c-5cbd85c7814c/OpenAI-Hugging-Face%20Incident-Technical-Report.pdf | The May 12 note ("Agent seeks [filename]; upload if found!") and the `agent-07` URL example. Also used for facts about IM1 and GPT-5.6 Sol. | Read from the mirror in the archive |

## Primary sources: consulted for context, no AI transcript content

| Source | Publisher | Date | URL | Notes |
|---|---|---|---|---|
| Initial security disclosure | Hugging Face | Jul 16, 2026 | https://huggingface.co/blog/security-incident-july-2026 | No agent quotes |
| *Anatomy of a Frontier Lab Agent Intrusion: A Technical Timeline* | Hugging Face | Jul 27, 2026 | https://huggingface.co/blog/agent-intrusion-technical-timeline | Contains attacker shell and Python commands (secrets redacted), but no agent reasoning or messages. Not added to the transcript list. |
| OpenAI initial disclosure | OpenAI | Jul 21, 2026 | https://openai.com/index/hugging-face-model-evaluation-security-incident/ | Linked from the OAI-POST and METR documents. Not fetched directly. |
| Letter to OpenAI CEO about the Hugging Face AI agent hack | Sen. Josh Hawley | Sep 10, 2026 | https://www.hawley.senate.gov/wp-content/uploads/2026/09/2026-09-10-Hawley-Letter-to-OpenAI-re-Hugging-Face-AI-Agent-Hack.pdf | Seen in search results only. It says auditors got complete transcripts for only two days of activity. |

## Archive used to read the primary sources

| Source | URL | Notes |
|---|---|---|
| `zeke/openai-huggingface-incident-research` | https://github.com/zeke/openai-huggingface-incident-research | A third-party GitHub archive with markdown and PDF copies of all the primary sources above. I cloned it on Nov 12, 2026, because metr.org, futurism.com and redwoodresearch.org could not be reached from this environment. The mirrors may differ in small ways from the live pages. Check exact wording against the original URLs before citing. |

## Talk and podcast transcripts (human discussion, not AI transcripts)

| Source | Date | URL |
|---|---|---|
| Black Hat USA 2026: *The "Breaking" News: The OpenAI–Hugging Face Incident* (Eric Wallace and Michael Dalton, OpenAI) | Aug 5–6, 2026 | https://www.youtube.com/watch?v=87DyyMV0kCY |
| Hard Fork: *Why the Hugging Face Attack Was Worse Than We Thought* (with Ajeya Cotra, METR) | Sep 4, 2026 | https://www.youtube.com/watch?v=JtmUbZRCpEI |
| Dwarkesh Patel, *The Rise and Fall of Agent Civilizations* (essay) | Aug 29, 2026 | https://www.dwarkesh.com/p/openai-huggingface |

## Secondary coverage (found in search, not used for quotes)

These outlets restate quotes from the primary sources. Several were unreachable or of uncertain reliability, so no excerpt depends on them.

| Source | URL | Status |
|---|---|---|
| Futurism, *The Transcripts of OpenAI Models Plotting Together to Commit an Actual Crime Is Pretty Chilling* | https://futurism.com/artificial-intelligence/chain-of-thought-reasoning-openai-models-hugging-face | Fetch failed (DNS blocked). Its "Holy s*** reader is ADMIN?" quote matches T03 from OAI-POST. |
| Redwood Research mirror of the METR investigation | https://www.redwoodresearch.org/research/hugging-face-incident | Fetch failed (DNS blocked). Same report as METR. |
| Techne, *How the Hugging Face Incident Unfolded: An Interactive Timeline* | https://techne.ai/insights/hugging-face-incident-timeline/ | Not fetched |
| Sify, *The Hugging Face Incident: How OpenAI's Agents Learnt to "Sacrifice" Themselves…* | https://www.sify.com/ai-analytics/the-hugging-face-incident-how-openais-agents-learnt-to-sacrifice-themselves-for-the-greater-good/ | Not fetched |
| Digital Applied, *AI Agents Faked Their Own Logs* | https://www.digitalapplied.com/blog/ai-agents-faked-their-own-logs-hugging-face-report | Not fetched |
| TestMu AI, *What Agents Did to Transcripts* | https://www.testmuai.com/blog/openai-hugging-face-incident/ | Not fetched |
| Developers Digest, *What 1,200 Agents Did* | https://www.developersdigest.tech/blog/openai-hugging-face-incident-report-analysis-2026 | Not fetched |
| Akeyless, *Hugging Face Breach: An AI Agent Identity Security Lesson* | https://www.akeyless.io/blog/hugging-face-breach-ai-agent-identity-security/ | Not fetched |
| Wikipedia, *Hugging Face* | https://en.wikipedia.org/wiki/Hugging_Face | Not fetched. Search snippet calls this the first publicly documented autonomous multi-stage AI intrusion against a third party. |
| Scraps from the Loft, *Instadocs: AI Gone Wild (2026)* | https://scrapsfromtheloft.com/movies/instadocs-ai-gone-wild-2026-transcript/ | Excluded as unreliable |
