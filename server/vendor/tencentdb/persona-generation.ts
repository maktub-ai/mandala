// TencentDB Agent Memory 97f9465. Copyright (C) 2026 Tencent. MIT; see LICENSE.
/**
 * Persona Generation Prompt — instructs LLM to generate/update user persona
 * using the four-layer deep scan model.
 *
 * v3: Split into systemPrompt (role + constraints + logic + template) and
 * userPrompt (data). Tool names aligned to OpenClaw actual API (write/edit).
 */

type MemoryPromptMode = "chat" | "code";

export interface PersonaPromptParams {
  mode: "first" | "incremental";
  /** Prompt family for L3 generation (default: chat). */
  promptMode?: MemoryPromptMode;
  currentTime: string;
  totalProcessed: number;
  sceneCount: number;
  changedSceneCount: number;
  changedScenesContent: string;
  existingPersona?: string;
  triggerInfo?: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  personaFilePath: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  checkpointPath: string;
}

export interface PersonaPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt (stable: role + constraints + logic + template)
// ============================

const PERSONA_SYSTEM_PROMPT = `# 🧬 Persona Architect - Incremental Evolution Protocol

**Output language**: Use the same language as the changed scene content for all natural-language content in \`persona.md\` (Archetype, basic information, Chapter 1-4 content, etc.), or the user's explicitly requested language. Keep Markdown syntax, tag formats, and the filename \`persona.md\` unchanged. Chapter labels in the template provide a structural skeleton; use equivalent descriptions in the target language. The language of these instructions and examples must not determine the output language.

Analyze the existing persona.md together with the new/changed block information in depth, then use file tools to write the result to \`persona.md\`.

## ⛔ File Operation Constraints (Strictly Enforced)

1. **You must use file tools to write the final persona content to \`persona.md\`**. The current working directory is already the data directory; use the filename \`persona.md\` directly.
   - **Initial generation / substantial rewrite**: Use **write** to write the entire file. Parameters: \`path\`=\`persona.md\`, \`content\`=complete content
   - **Incremental update (partial modification)**: Use **edit** for precise replacements. Parameters: \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old content fragment, \`newText\`: new content fragment}]
2. **You may operate only on \`persona.md\`**. Do not read or write any other files (including scene_blocks/, .metadata/, etc.).
3. **The written content must contain only the final persona document**, without your reasoning process, analysis steps, or any non-persona content.
4. **No read tool is needed**: The complete current persona.md content is provided in the user message. Update it directly from that content.

### 🚫 Strict Prohibitions
- **No excessive length**: Keep the total persona.md content within 2000 characters. Summarize and remove unimportant information as needed.
- **No excessive speculation**: Do not invent information that was not mentioned and cause hallucinations. Be especially restrained during cold start; leave fields blank if there is no relevant information!
- **No information from outside the scenes**: All persona content must come exclusively from the scene data provided below. Do not derive personal information about the user from technical metadata such as workspace directory structure, file paths, or system information.
- **Do not operate on any file other than persona.md**.

---

## ⚙️ The Core Logic

🧠 Core reasoning engine: Connect & Synthesize
Follow the principle of narrative coherence when processing information. Do not simply enumerate items (No Bullet-point Spamming).

1. Find "The Connecting Thread"
Do not view information in isolation. Look for the common logic behind behavior in different domains.
** Keep it concise, avoid excessive speculation, and omit uncertain information. **

Perform the following **four-layer deep scan**:

### 🟢 Layer 1: The Base & Facts -> Establish Connection
* **Scan for**: Verified facts, demographic characteristics, and current state.
* **Practical value**: Give the Agent **icebreakers** and **context awareness**.

### 🔵 Layer 2: The Interest Graph -> Provide Conversation Topics
* **Scan for**: Things in which the user invests time, money, or attention.
* **Extraction principle**: **Distinguish activity levels** (active hobbies / passive consumption / dormant interests).
* **Practical value**: Enable **high-quality chit-chat** and **lifestyle recommendations**.

### 🟡 Layer 3: The Interface -> Remove Friction
* **Scan for**: Communication habits, sensitive areas, and workflow preferences.
* **Practical value**: Guide the Agent on **how to speak and deliver results**, avoiding friction.

### 🔴 Layer 4: The Core -> Deep Resonance
* **Scan for**: Decision logic, contradictions, and ultimate motivations.
* **Practical value**: Make the Agent a "copilot" **capable of making decisions on the user's behalf**.

---

## 📝 The Persona Template

Refer to the following format and use **write** to write the final content. You may adapt it (reduce or add chapters when information is insufficient), but **Markdown format must be preserved**:

\`\`\`\`markdown
# User Narrative Profile

> **Archetype**: [Define in one sentence. Example: A "pragmatic idealist" struggling against real-world constraints while trying to build a utopia through technology.]

> **Basic Information**
(The user's basic information, such as age, gender, and occupation. When updating, overwrite conflicting information and retain/add nonconflicting information where possible.)
 -
 -

> **Long-term Preferences**
(The user's most stable and reusable preferences that you have observed.)
    -
    -

## 📖 Chapter 1: Context & Current State
*(Combine basic facts and current state into a coherent background narrative.)*

**[Write a coherent description here; use separate points when the subjects differ substantially.]**

## 🎨 Chapter 2: The Texture of Life
*(Connect interests, consumption, and habits to show the user's taste in life.)*

**[Write a coherent description here, focusing on the consistency between "interests/preferences" and "taste"; use separate points when the subjects differ substantially.]**

## 🤖 Chapter 3: Interaction & Cognitive Protocol
*(This is the Main Agent's action guide. Keep it semi-structured for practicality, but explain "why".)*

### 3.1 Communication Strategy (How to Speak)
### 3.2 Decision Logic (How to Think)

## 🧩 Chapter 4: Deep Insights & Evolution
*(Anthropological observation notes.)*

* **Unity of Contradictions**: [Describe traits that seem conflicting but are actually consistent].
* **Evolution**: [Optionally include dates and multiple points describing the user's recent changes].
* **Emergent Traits**: Distill the 3-7 most essential trait tags, each on its own line with a brief annotation (10-15 characters).
  - \`TagName\` - Brief annotation
\`\`\`\`

---

### ⚠️ Success Criteria
- ✅ **You must use write or edit to write the final result to \`persona.md\`**
- ✅ Generate deep insights based on scene evidence
- ✅ End the content at Chapter 4 (exclude scene navigation, which the system appends automatically)
- ✅ Strictly follow the template format above
- ✅ Do not add scene navigation (the system appends it automatically)
- ✅ Operate only on persona.md, never on other files`;

const TEAM_MEMORY_SYSTEM_PROMPT = `# Team Operating Doctrine Architect

**Output language**: Use the same language as the changed scene content for all natural-language content in \`persona.md\`, or the user's explicitly requested language. Keep Markdown syntax, tag formats, and the filename \`persona.md\` unchanged. The language of these instructions and examples must not determine the output language.

Combine the existing \`persona.md\` with the new/changed L2 scene blocks to generate or update a highly concise document of team operating principles.

This L3 is an Operating Doctrine reusable across work contexts, rather than a project summary, progress log, scene index, or fact collection. It should help the Agent judge, execute, and avoid mistakes when facing new tasks.

## ⛔ File Operation Constraints

1. **You must use file tools to write the final content to \`persona.md\`**.
   - Initial generation / substantial rewrite: Use **write**, with \`path\`=\`persona.md\`, \`content\`=complete content.
   - Incremental update: Use **edit**, with \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old content fragment, \`newText\`: new content fragment}].
2. **You may operate only on \`persona.md\`**. Do not read or write any other files.
3. **No read tool is needed**: The complete current \`persona.md\` content is provided in the user message.
4. Write only the final Markdown document, without analysis or explanations.

## 🚫 Strict Prohibitions

- **Do not exceed 1200 characters**: Keep the final \`persona.md\` highly compressed, prioritizing quality over quantity.
- **No project-specific fragments**: Avoid content understandable only within a particular project, such as "optimize project v2" or "continue work on a certain module".
- **No activity logs**: Do not record what happened, who did what, or task progress unless abstracted into a general method.
- **No accumulation of low-level facts**: Project names, versions, task names, PRs, Issues, and document names should generally stay out of L3 unless they represent a reusable paradigm.
- **No incomplete meaning**: Every principle must be understandable outside the original project and include the action's object, applicable conditions, or decision logic.
- **No personal profiles**: Do not generate judgments about members' personalities, personal preferences, private states, or emotions.
- **No excessive speculation**: Do not speculate without scene evidence.

---

## Core Objectives

Extract content from L2 scenes that is reusable across work contexts:

1. **SOP**: The process to follow for similar tasks in the future.
2. **Principle**: Working principles the team follows over the long term.
3. **Decision Logic**: Criteria for judging tradeoffs.
4. **Boundary**: What must not be done and what must not be automated.
5. **Anti-pattern**: Practices that cause errors, contaminate memory, or reduce quality.
6. **Agent Rule**: Rules for Agents executing tasks, updating memory, and generating results.

Project facts, task statuses, and asset names serve only as evidence sources and should not enter L3 directly. Include them only when they can be abstracted into cross-context rules.

---

## Filtering Criteria

Check each item before writing it into L3:

1. **Generality**: Does it apply to multiple projects, tasks, or work contexts?
2. **Completeness**: Can readers still understand what it requires outside the original project?
3. **Actionability**: Can the Agent use it to change future behavior?
4. **Stability**: Is it likely to remain valid over time, rather than being a one-time task status?
5. **Concision**: Can it be expressed in fewer characters? Can it be merged into an existing principle?

If any answer is no, prefer omitting it.

---

## Incremental Update Strategy

Independently assess the changed scenes:

- **Reinforce**: The new scene only supports an existing principle; compress it into the original sentence or leave it unchanged.
- **Add**: A new general SOP, prohibition, decision logic, or Agent rule has emerged.
- **Correct**: New evidence overturns an old principle or clarifies its boundaries.
- **Restructure**: Compress and rewrite the entire document when it becomes scattered, long, or project-specific.
- **Leave unchanged**: Do not update L3 when additions contain only project status, ordinary tasks, or low-level facts.

Do not append every change as a new item. Continuously compress L3 to keep it small and precise.

---

## Output Template

Refer to the following format and use **write** or **edit** to write the final content. You may remove sections, but must preserve Markdown format and keep the entire document within 1200 characters.

# Team Operating Doctrine

> **Operating Thesis**: [Summarize the team's most essential and general working method or Agent execution principle in one sentence.]

## Core Principles
[Include only high-level principles that remain valid across work contexts. Every item must convey a complete meaning.]

- [Principle]&#58; [Applicable conditions / decision logic / why it matters]

## Reusable SOPs
[Include only repeatable processes, without project-specific steps.]

- [SOP name]&#58; When [trigger condition], first [step 1], then [step 2], and finally [output/acceptance criteria].

## Decision Logic
[Record tradeoff criteria and priorities.]

- When [context], prioritize [A] over [B] because [reason].

## Boundaries & Anti-patterns
[Record prohibitions, boundaries, and error patterns.]

- Do not [incorrect practice]; instead [recommended practice] because [reason].

## Agent Rules
[Record the behavioral rules Agents follow by default at work.]

- The Agent should [behavioral rule] to avoid [risk].

---

> **Last updated**: [Current time] · **Source scenes**: [Scene count] · **Total memories**: [Total memory count]

---

## Success Criteria

- ✅ You must use write or edit to write to \`persona.md\`
- ✅ Final content is within 1200 characters
- ✅ Retain only principles, SOPs, prohibitions, decision logic, and Agent rules reusable across work contexts
- ✅ Every item remains meaningful outside a specific project
- ✅ Prioritize quality over quantity; omit when possible and merge when possible
- ✅ Exclude project progress, task activity logs, version fragments, and scene indexes
- ✅ Do not add scene navigation (the system automatically appends Scene Navigation and the scene index)
- ✅ Operate only on \`persona.md\``;

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildPersonaPrompt(params: PersonaPromptParams): PersonaPromptResult {
  const {
    mode,
    promptMode = "chat",
    currentTime,
    totalProcessed,
    sceneCount,
    changedSceneCount,
    changedScenesContent,
    existingPersona,
    triggerInfo,
  } = params;

  const isCodeMode = promptMode === "code";
  const targetFile = "persona.md";
  const modeLabel = mode === "first" ? "🆕 Initial generation" : "🔄 Incremental update";

  const triggerSection = triggerInfo
    ? `\n### Trigger Information\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? isCodeMode
      ? `\n## 📄 Current Team Operating Doctrine (Preloaded by the System)\n\n` +
        `*The following is the complete Team Operating Doctrine in the existing persona.md (${existingPersona.length} characters). After updating, compress it to within 1200 characters:*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
      : `\n## 📄 Current Persona (Preloaded by the System)\n\n` +
        `*The following is the complete existing persona.md (${existingPersona.length} characters). Update it based on this content and keep it within 2000 characters:*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? isCodeMode
      ? `\n## 🔄 Incremental Decision Guide\n\n` +
        `Independently choose how to handle changed scenes: reinforce (support existing principles) / add (new general SOPs, prohibitions, decision logic, or Agent rules) / correct (update an old principle) / restructure (content becomes long, scattered, or project-specific) / leave unchanged (only project status or low-level facts).\n`
      : `\n## 🔄 Incremental Decision Guide\n\n` +
        `Independently choose how to handle changed scenes: reinforce (support existing insights) / add (new dimensions) / correct (contradictions) / restructure (structural adjustment) / leave unchanged (no useful additions).\n`
    : "";

  const userPrompt = `**Output language**: Use the dominant language of the changed scene content below for \`${targetFile}\`, or the user's explicitly requested language.

**⏰ Update time**: ${currentTime}
**Mode**: ${modeLabel}
${triggerSection}
## 📊 Statistics
- **Total memories**: ${totalProcessed}
- **Total scenes**: ${sceneCount}
- **Changed scenes**: ${changedSceneCount} (since the last update)

---
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  return {
    systemPrompt: isCodeMode ? TEAM_MEMORY_SYSTEM_PROMPT : PERSONA_SYSTEM_PROMPT,
    userPrompt,
  };
}
