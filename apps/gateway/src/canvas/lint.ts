import vm from "node:vm";
import { parseDashboardQueries } from "./sql.js";

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const JS_TYPES = new Set(["", "text/javascript", "application/javascript"]);
// Unforgeable browser globals: a top-level `const top` throws in a real page.
const UNFORGEABLE = ["top", "window", "document", "location"];

type Script = { src?: string; module: boolean; code: string; offset: number };

const lineAt = (html: string, index: number) =>
  html.slice(0, index).split("\n").length - 1;

function parseScripts(html: string): Script[] {
  const scripts: Script[] = [];
  for (const match of html.matchAll(SCRIPT)) {
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(match[1])?.[1] ?? "";
    const src = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(match[1])?.[1];
    const module = type.toLowerCase() === "module";
    if (!module && !JS_TYPES.has(type.toLowerCase())) continue;
    const bodyStart = match.index + match[0].indexOf(">") + 1;
    scripts.push({
      src,
      module,
      code: match[2],
      offset: lineAt(html, bodyStart),
    });
  }
  return scripts;
}

// vm errors come from another realm, so read fields instead of instanceof.
function reason(error: unknown): { message: string; line?: number } {
  const e = error as { message?: string; stack?: string };
  const line = /:(\d+)\n/.exec(e.stack ?? "")?.[1];
  return {
    message: e.message ?? String(error),
    line: line ? Number(line) : undefined,
  };
}

function syntaxProblem(script: Script, index: number): string | undefined {
  // Module code is wrapped so it compiles as a function body (no imports).
  const wrap = script.module;
  try {
    new vm.Script(
      wrap
        ? `"use strict";(async function(){\n${script.code}\n})`
        : script.code,
      {
        filename: `script-${index}.js`,
        lineOffset: script.offset - (wrap ? 1 : 0),
      }
    );
    return undefined;
  } catch (error) {
    const { message, line } = reason(error);
    const hint = /import|export/i.test(message)
      ? " Imports and exports are not supported; the page script must be self-contained."
      : "";
    return `Script ${index + 1}${line ? ` (line ${line})` : ""}: syntax error: ${message}.${hint}`;
  }
}

// Instantiates each classic script's global declarations without running any
// of its code: `throw 0;` on the same line stops execution right after
// GlobalDeclarationInstantiation, which is where redeclarations are rejected.
function collisionProblems(scripts: Array<[Script, number]>): string[] {
  const context = vm.createContext({});
  vm.runInContext(
    `for (const n of ${JSON.stringify(UNFORGEABLE)}) Object.defineProperty(globalThis, n, { value: {}, configurable: false });`,
    context
  );
  const problems: string[] = [];
  for (const [script, index] of scripts) {
    try {
      new vm.Script(`throw 0;${script.code}`, {
        filename: `script-${index}.js`,
        lineOffset: script.offset,
      }).runInContext(context, { timeout: 100 });
    } catch (error) {
      if (error === 0) continue;
      const { message } = reason(error);
      problems.push(
        `Script ${index + 1}: ${message}. Classic scripts share one global scope with the browser and other scripts; put page code in a single <script type="module"> or rename the declaration.`
      );
    }
  }
  return problems;
}

export function lintDashboardHtml(html: string): string[] {
  const scripts = parseScripts(html);
  const inline = scripts
    .map((s, i) => [s, i] as [Script, number])
    .filter(([s]) => !s.src);
  const problems: string[] = [];

  const compiled: Array<[Script, number]> = [];
  for (const entry of inline) {
    const problem = syntaxProblem(...entry);
    if (problem) problems.push(problem);
    else if (!entry[0].module) compiled.push(entry);
  }
  problems.push(...collisionProblems(compiled));

  const code = inline.map(([script]) => script.code).join("\n");
  const srcs = scripts.map((s) => s.src ?? "");
  const kit = srcs.findIndex((src) => src.endsWith("/kit.js"));
  const echarts = srcs.findIndex((src) => src.endsWith("/echarts.js"));
  if (/\/d-assets\/v1\//.test(html)) {
    problems.push(
      "Outdated Dashboard Kit assets: use /d-assets/v2/ instead of /d-assets/v1/."
    );
  }
  if (kit < 0 && /\bDashboardKit\b/.test(code)) {
    problems.push(
      'DashboardKit is used but <script src="/d-assets/v2/kit.js"> is not loaded.'
    );
  }
  if (/\.chart\s*\(/.test(code) && echarts < 0) {
    problems.push(
      'Charts are used but <script src="/d-assets/v2/echarts.js"> is not loaded (before kit.js).'
    );
  } else if (kit >= 0 && echarts > kit) {
    problems.push(
      "Load echarts.js before kit.js; kit.js needs it to draw charts."
    );
  }

  let declared: Set<string>;
  try {
    declared = new Set(parseDashboardQueries(html).map((query) => query.name));
  } catch {
    declared = new Set(); // reported as a query error already
  }
  const names = new Set(
    [
      ...code.matchAll(/YOPLAI\.data\.([A-Za-z_$][\w$]*)/g),
      ...code.matchAll(/YOPLAI\.data\[\s*["']([^"']+)["']\s*\]/g),
    ].map((match) => match[1])
  );
  for (const name of names) {
    if (!declared.has(name)) {
      problems.push(
        `YOPLAI.data.${name} is used but no <script type="application/sql" data-name="${name}"> query declares it.`
      );
    }
  }

  if (scripts.some((script) => script.module)) {
    const markup = html.replace(SCRIPT, (block) =>
      block.replace(/[^\n]/g, " ")
    );
    for (const match of markup.matchAll(/<[a-z][^>]*?\s(on[a-z]+)\s*=/gi)) {
      problems.push(
        `Line ${lineAt(markup, match.index) + 1}: inline ${match[1]}= handler will not find functions declared in a module script; use addEventListener.`
      );
    }
  }
  return problems;
}
