type CodeToken = {
  key: string;
  value: string;
};

function protectCode(input: string): { text: string; tokens: CodeToken[] } {
  const tokens: CodeToken[] = [];
  const replace = (value: string) => {
    const key = `@@YOPLAI_CODE_${tokens.length}@@`;
    tokens.push({ key, value });
    return key;
  };

  const withoutBlocks = input.replace(/```[\s\S]*?```/g, replace);
  return {
    text: withoutBlocks.replace(/`[^`\n]*`/g, replace),
    tokens,
  };
}

function restoreCode(input: string, tokens: CodeToken[]): string {
  return tokens.reduce(
    (text, token) => text.replaceAll(token.key, token.value),
    input
  );
}

function parseTableRow(line: string): string[] | null {
  if (!line.includes("|")) return null;
  const trimmed = line.trim();
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = body.split("|").map((cell) => cell.trim());
  return cells.length > 1 ? cells : null;
}

function isTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  return Boolean(cells?.every((cell) => /^:?-{3,}:?$/.test(cell)));
}

function tableRowToBullet(headers: string[], row: string[]): string {
  const items = row
    .map((cell, index) => {
      const header = headers[index];
      return header ? `${header}: ${cell}` : cell;
    })
    .filter((item) => item.trim().length > 0);
  return `- ${items.join("; ")}`;
}

function convertTables(input: string): string {
  const lines = input.split("\n");
  const output: string[] = [];

  let index = 0;
  while (index < lines.length) {
    const headers = parseTableRow(lines[index]);
    if (!headers || !lines[index + 1] || !isTableSeparator(lines[index + 1])) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const rows: string[][] = [];
    index += 2;
    while (index < lines.length) {
      const row = parseTableRow(lines[index]);
      if (!row || isTableSeparator(lines[index])) {
        break;
      }
      rows.push(row);
      index += 1;
    }

    if (rows.length === 0) {
      output.push(headers.join(" | "));
      continue;
    }

    output.push(...rows.map((row) => tableRowToBullet(headers, row)));
  }

  return output.join("\n");
}

export function markdownToMrkdwn(input: string): string {
  const { text, tokens } = protectCode(input);
  const converted = convertTables(text)
    .replace(/!\[[^\]\n]*\]\([^)]+\)/g, "")
    .replace(/<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+[^<>]*)?>/g, "")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "<$2|$1>")
    .replace(/\*\*([^*\n](?:[^\n*]|\*(?!\*))*?)\*\*/g, "*$1*")
    .replace(/__([^_\n](?:[^\n_]|_(?!_))*?)__/g, "_$1_");

  return restoreCode(converted, tokens);
}
