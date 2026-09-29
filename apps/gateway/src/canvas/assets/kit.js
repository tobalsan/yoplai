(function (global) {
  "use strict";

  const { document, URL, Blob, getComputedStyle } = global;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const AUTO = { type: "number" };
  const NUMERIC = new Set([
    "number",
    "integer",
    "compact",
    "percent",
    "currency",
  ]);
  const TONE_RANK = { critical: 4, warn: 3, info: 2, accent: 1, good: 1 };
  const find = (target) =>
    typeof target === "string" ? document.querySelector(target) : target;
  const text = (value) => (value == null ? "" : String(value));
  const node = (tag, className, content) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content != null) element.textContent = text(content);
    return element;
  };
  const mount = (target, element) => {
    const root = find(target);
    if (!root) throw new Error("Dashboard Kit target not found");
    root.replaceChildren(element);
    return element;
  };
  const notice = (root, message) => {
    root.replaceChildren(node("div", "dk-notice", message));
    return null;
  };

  function parseFormat(spec) {
    if (!spec) return {};
    if (typeof spec === "object") return spec;
    const [type, currency] = String(spec).split(":");
    if (type === "compact" && currency)
      return { type: "currency", currency, compact: true };
    return { type, currency };
  }

  // Formats numbers, currency, percentages (ratio 0-1), and dates for display.
  function format(value, spec) {
    if (value == null || value === "") return "—";
    const options = parseFormat(spec);
    const type = options.type || "number";
    const locale = api.locale || document.documentElement.lang || undefined;
    if (type === "raw") return text(value);
    if (type === "date" || type === "datetime") {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return text(value);
      return new Intl.DateTimeFormat(
        locale,
        type === "date"
          ? { dateStyle: "medium", timeZone: "UTC" }
          : { dateStyle: "medium", timeStyle: "short" }
      ).format(date);
    }
    const number = typeof value === "number" ? value : Number(value);
    if (typeof value === "boolean" || !Number.isFinite(number))
      return text(value);
    const digits = options.digits;
    const intl = {
      minimumFractionDigits: digits ?? 0,
      maximumFractionDigits: digits ?? (type === "integer" ? 0 : 2),
    };
    if (type === "percent") {
      intl.style = "percent";
      intl.minimumFractionDigits = digits ?? 1;
      intl.maximumFractionDigits = digits ?? 1;
    }
    if (type === "currency") {
      const cents = Number.isInteger(number) || Math.abs(number) >= 100 ? 0 : 2;
      intl.style = "currency";
      intl.currency = options.currency || "USD";
      intl.minimumFractionDigits = digits ?? cents;
      intl.maximumFractionDigits = digits ?? cents;
    }
    if (type === "compact" || options.compact) {
      intl.notation = "compact";
      intl.minimumFractionDigits = 0;
      intl.maximumFractionDigits = digits ?? 1;
    }
    try {
      return new Intl.NumberFormat(locale, intl).format(number);
    } catch {
      return text(value);
    }
  }

  const signed = (value, spec) => {
    const body = format(Math.abs(value), spec);
    if (value > 0) return `+${body}`;
    return value < 0 ? `−${body}` : body;
  };

  function pill(label, tone) {
    const element = node("span", "dk-pill", label);
    element.dataset.tone = tone || "neutral";
    return element;
  }

  function dot(tone) {
    const element = node("span", "dk-dot");
    element.dataset.tone = tone || "neutral";
    element.setAttribute("aria-hidden", "true");
    return element;
  }

  function sparkline(values, options = {}) {
    const points = (values || []).map(Number).filter(Number.isFinite);
    const width = options.width || 96;
    const height = options.height || 28;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "dk-spark");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("aria-hidden", "true");
    if (points.length < 2) return svg;
    const min = Math.min(...points);
    const span = Math.max(...points) - min || 1;
    const xy = points.map((value, index) => [
      (index / (points.length - 1)) * (width - 3) + 1.5,
      height - 3 - ((value - min) / span) * (height - 6),
    ]);
    const line = xy
      .map(
        ([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`
      )
      .join("");
    const shape = (tag, className, attributes) => {
      const element = document.createElementNS(SVG_NS, tag);
      element.setAttribute("class", className);
      Object.entries(attributes).forEach(([key, value]) =>
        element.setAttribute(key, String(value))
      );
      svg.append(element);
    };
    const [lastX, lastY] = xy[xy.length - 1];
    shape("path", "dk-spark-area", {
      d: `${line}L${lastX.toFixed(1)} ${height}L${xy[0][0].toFixed(1)} ${height}Z`,
    });
    shape("path", "dk-spark-line", { d: line });
    shape("circle", "dk-spark-dot", { cx: lastX, cy: lastY, r: 2.25 });
    return svg;
  }

  function kpiNode(options) {
    const card = node("section", "dk-card dk-kpi");
    if (options.emphasis) card.classList.add("dk-kpi--emphasis");
    const shown =
      options.format || typeof options.value === "number"
        ? format(options.value, options.format || AUTO)
        : options.value;
    const main = node("div", "dk-kpi-main");
    main.append(node("strong", "dk-value", shown));
    if (options.trend) main.append(sparkline(options.trend));
    card.append(node("span", "dk-label", options.label), main);
    const foot = node("div", "dk-kpi-foot");
    if (options.delta != null) {
      const numeric = typeof options.delta === "number";
      const direction =
        options.direction ||
        (numeric && options.delta > 0
          ? "up"
          : numeric && options.delta < 0
            ? "down"
            : "neutral");
      const delta = node(
        "span",
        "dk-delta",
        numeric
          ? signed(options.delta, options.deltaFormat || options.format || AUTO)
          : options.delta
      );
      delta.dataset.direction = direction;
      delta.dataset.sentiment =
        direction === "up" || direction === "down"
          ? direction === (options.good || "up")
            ? "positive"
            : "negative"
          : "neutral";
      foot.append(delta);
    }
    if (options.note != null)
      foot.append(node("span", "dk-note", options.note));
    if (foot.childNodes.length) card.append(foot);
    return card;
  }

  function kpi(target, options) {
    return mount(target, kpiNode(options));
  }

  // One joined KPI strip; the last tile stretches so rows never leave holes.
  function kpis(target, options) {
    const items = Array.isArray(options) ? options : options.items;
    const count = items.length;
    const columns = Math.max(
      1,
      options.columns ||
        (count <= 6 ? count : Math.min(6, Math.ceil(count / 2)))
    );
    const root = node("div", "dk-kpis");
    root.style.setProperty("--dk-cols", String(columns));
    items.forEach((item) => root.append(kpiNode(item)));
    const remainder = count % columns;
    if (remainder && root.lastChild)
      root.lastChild.style.gridColumn = `span ${columns - remainder + 1}`;
    return mount(target, root);
  }

  function callout(target, options) {
    const items = (options.items || []).map((item) =>
      typeof item === "string" ? { text: item } : item
    );
    const root = node("section", "dk-callout");
    root.dataset.tone =
      options.tone ||
      items.reduce(
        (worst, item) =>
          (TONE_RANK[item.tone] || 0) > (TONE_RANK[worst] || 0)
            ? item.tone
            : worst,
        "neutral"
      );
    if (options.title)
      root.append(node("h2", "dk-callout-title", options.title));
    if (options.note) root.append(node("p", "dk-note", options.note));
    const list = node("ul", "dk-callout-list");
    if (!items.length && options.empty)
      items.push({ text: options.empty, tone: "good" });
    items.forEach((item) => {
      const li = node("li");
      const label = node(
        item.href ? "a" : "span",
        "dk-callout-text",
        item.text
      );
      if (item.href) label.href = item.href;
      li.append(dot(item.tone), label);
      if (item.value != null)
        li.append(
          node(
            "span",
            "dk-callout-value",
            typeof item.value === "number"
              ? format(item.value, AUTO)
              : item.value
          )
        );
      list.append(li);
    });
    root.append(list);
    return mount(target, root);
  }

  function csv(rows, columns) {
    const escape = (value) => `"${text(value).replaceAll('"', '""')}"`;
    return [
      columns.map((column) => escape(column.label || column.key)).join(","),
      ...rows.map((row) =>
        columns.map((column) => escape(row[column.key])).join(",")
      ),
    ].join("\r\n");
  }

  function downloadCsv(filename, rows, columns) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([csv(rows, columns)], { type: "text/csv;charset=utf-8" })
    );
    link.download = filename || "dashboard.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function isNumeric(column, rows) {
    if (column.align) return column.align === "end" || column.align === "right";
    if (column.format)
      return NUMERIC.has(parseFormat(column.format).type || "number");
    const values = rows
      .map((row) => row[column.key])
      .filter((value) => value != null && value !== "");
    return (
      values.length > 0 && values.every((value) => typeof value === "number")
    );
  }

  function cell(column, row) {
    const value = row[column.key];
    if (column.render) {
      const rendered = column.render(value, row);
      return rendered instanceof global.Node
        ? rendered
        : document.createTextNode(text(rendered));
    }
    let content;
    if (column.pill && value != null && value !== "") {
      content = document.createDocumentFragment();
      (Array.isArray(value) ? value : [value]).forEach((item) => {
        const tone =
          typeof column.pill === "function"
            ? column.pill(item, row)
            : typeof column.pill === "object"
              ? column.pill[item]
              : "neutral";
        content.append(
          pill(column.format ? format(item, column.format) : item, tone)
        );
      });
    } else {
      content = document.createTextNode(
        column.format ? format(value, column.format) : text(value)
      );
    }
    const href = column.href?.(row);
    if (!href) return content;
    const link = node("a");
    link.href = href;
    link.append(content);
    return link;
  }

  function table(target, options) {
    const root = node("section", "dk-table-wrap");
    const columns = options.columns;
    const rows = [...options.rows];
    const numeric = columns.map((column) => isNumeric(column, rows));
    const limit = options.limit;
    let search;
    let sortKey;
    let ascending = true;
    let expanded = false;
    // Without search, the export action moves to the footer.
    const exportButton =
      options.csv === false
        ? null
        : node(
            "button",
            options.search === false ? "dk-link-button" : "dk-button",
            "Export CSV"
          );
    exportButton?.addEventListener("click", () =>
      downloadCsv(options.filename, rows, columns)
    );
    if (exportButton) exportButton.type = "button";
    if (options.search !== false) {
      const toolbar = node("div", "dk-toolbar");
      search = node("input", "dk-search");
      search.type = "search";
      search.placeholder = "Search";
      search.setAttribute("aria-label", "Search rows");
      toolbar.append(search);
      if (exportButton) toolbar.append(exportButton);
      root.append(toolbar);
    }
    const scroll = node("div", "dk-table-scroll");
    const tableNode = node("table", "dk-table");
    const foot = node("div", "dk-table-foot");
    scroll.append(tableNode);
    root.append(scroll);
    const compare = (a, b) =>
      typeof a === "number" && typeof b === "number"
        ? a - b
        : text(a).localeCompare(text(b), undefined, { numeric: true });
    const render = () => {
      const query = search ? search.value.toLowerCase() : "";
      let visible = rows.filter((row) =>
        Object.values(row).some((value) =>
          text(value).toLowerCase().includes(query)
        )
      );
      if (sortKey)
        visible = [...visible].sort(
          (a, b) => compare(a[sortKey], b[sortKey]) * (ascending ? 1 : -1)
        );
      const total = visible.length;
      const shown =
        limit && !expanded && total > limit ? visible.slice(0, limit) : visible;
      const head = node("thead");
      const headRow = node("tr");
      if (options.rowTone) headRow.append(node("th", "dk-tone-cell"));
      columns.forEach((column, index) => {
        const header = node(
          "th",
          numeric[index] ? "dk-num" : null,
          column.label || column.key
        );
        header.tabIndex = 0;
        header.scope = "col";
        if (sortKey === column.key)
          header.setAttribute(
            "aria-sort",
            ascending ? "ascending" : "descending"
          );
        const sort = () => {
          ascending = sortKey === column.key ? !ascending : true;
          sortKey = column.key;
          render();
        };
        header.addEventListener("click", sort);
        header.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          sort();
        });
        headRow.append(header);
      });
      head.append(headRow);
      const body = node("tbody");
      shown.forEach((row) => {
        const tr = node("tr");
        if (options.rowTone) {
          const marker = node("td", "dk-tone-cell");
          marker.append(dot(options.rowTone(row)));
          tr.append(marker);
        }
        columns.forEach((column, index) => {
          const td = node("td", numeric[index] ? "dk-num" : null);
          td.append(cell(column, row));
          tr.append(td);
        });
        body.append(tr);
      });
      if (!total) {
        const empty = node(
          "td",
          "dk-empty",
          options.empty || "No matching rows"
        );
        empty.colSpan = columns.length + (options.rowTone ? 1 : 0);
        const tr = node("tr");
        tr.append(empty);
        body.append(tr);
      }
      tableNode.replaceChildren(head, body);
      const capped = Boolean(limit && total > limit);
      const footExport = options.search === false ? exportButton : null;
      if (capped || footExport) {
        const actions = node("span", "dk-table-actions");
        if (footExport) actions.append(footExport);
        const toggle = node(
          "button",
          "dk-link-button",
          expanded ? "Show fewer" : `Show all ${format(total, "number")}`
        );
        toggle.type = "button";
        toggle.addEventListener("click", () => {
          expanded = !expanded;
          render();
        });
        if (capped) actions.append(toggle);
        foot.replaceChildren(
          node(
            "span",
            null,
            capped && !expanded
              ? `${format(limit, "number")} of ${format(total, "number")} rows`
              : `${format(total, "number")} rows`
          ),
          actions
        );
        root.append(foot);
      } else foot.remove();
    };
    search?.addEventListener("input", () => {
      expanded = false;
      render();
    });
    render();
    return mount(target, root);
  }

  function list(target, options) {
    const ordered = node("ol", "dk-list");
    options.items.forEach((item) => {
      const li = node("li");
      const content = item.href
        ? node("a", null, item.label)
        : node("span", null, item.label);
      if (item.href) content.href = item.href;
      li.append(content);
      if (item.value != null)
        li.append(
          node(
            "strong",
            null,
            typeof item.value === "number"
              ? format(item.value, AUTO)
              : item.value
          )
        );
      ordered.append(li);
    });
    return mount(target, ordered);
  }

  function tabs(target, options) {
    const root = node("section", "dk-tabs");
    const nav = node("div", "dk-tab-list");
    nav.setAttribute("role", "tablist");
    const panel = node("div", "dk-tab-panel");
    const select = (tab) => {
      [...nav.children].forEach((button) =>
        button.setAttribute(
          "aria-selected",
          String(button.dataset.id === tab.id)
        )
      );
      panel.replaceChildren(
        typeof tab.content === "string"
          ? node("div", null, tab.content)
          : tab.content
      );
      options.onChange?.(tab.id);
    };
    options.tabs.forEach((tab) => {
      const button = node("button", "dk-tab", tab.label);
      button.dataset.id = tab.id;
      button.setAttribute("role", "tab");
      button.addEventListener("click", () => select(tab));
      nav.append(button);
    });
    root.append(nav, panel);
    select(
      options.tabs.find((tab) => tab.id === options.active) || options.tabs[0]
    );
    return mount(target, root);
  }

  function segmented(target, options) {
    const root = node("div", "dk-segmented");
    root.setAttribute("role", "group");
    if (options.label) root.setAttribute("aria-label", options.label);
    const choices = options.options.map((choice) =>
      typeof choice === "object" ? choice : { value: choice, label: choice }
    );
    let current = options.value ?? choices[0]?.value;
    const buttons = choices.map((choice) => {
      const button = node("button", null, choice.label ?? choice.value);
      button.type = "button";
      button.addEventListener("click", () => {
        current = choice.value;
        sync();
        options.onChange?.(current);
      });
      return button;
    });
    const sync = () =>
      buttons.forEach((button, index) =>
        button.setAttribute(
          "aria-pressed",
          String(choices[index].value === current)
        )
      );
    sync();
    root.append(...buttons);
    return mount(target, root);
  }

  function filters(target, options) {
    const form = node("form", "dk-filters");
    const state = {};
    options.fields.forEach((field) => {
      const label = node("label", "dk-filter");
      label.append(node("span", null, field.label));
      let input;
      if (field.type === "select") {
        input = node("select");
        field.options.forEach((option) => {
          const item = node("option", null, option.label);
          item.value = option.value;
          input.append(item);
        });
      } else {
        input = node("input");
        input.type = field.type;
        if (field.min != null) input.min = field.min;
        if (field.max != null) input.max = field.max;
      }
      input.name = field.name;
      if (field.value != null) input.value = String(field.value);
      state[field.name] = input.value;
      input.addEventListener("input", () => {
        state[field.name] = input.value;
        options.onChange?.({ ...state });
      });
      label.append(input);
      form.append(label);
    });
    return mount(target, form);
  }

  function md(target, markdown) {
    if (!global.marked || !global.DOMPurify) {
      const root = find(target);
      if (!root) throw new Error("Dashboard Kit target not found");
      return notice(
        root,
        "Markdown unavailable: load marked.js and purify.js before kit.js."
      );
    }
    const root = node("article", "dk-markdown");
    root.innerHTML = global.DOMPurify.sanitize(global.marked.parse(markdown));
    return mount(target, root);
  }

  // ---- charts -------------------------------------------------------------

  let probeContext;
  // Resolves any CSS color (var(), color-mix(), oklch()...) to [r, g, b, a].
  function rgba(value, host) {
    const probe = node("span");
    probe.style.display = "none";
    probe.style.color = value;
    (host || document.documentElement).append(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    if (probeContext === undefined)
      probeContext =
        document
          .createElement("canvas")
          .getContext?.("2d", { willReadFrequently: true }) || null;
    if (probeContext) {
      probeContext.clearRect(0, 0, 1, 1);
      probeContext.fillStyle = "#000";
      probeContext.fillStyle = computed;
      probeContext.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = probeContext.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    }
    const parts = (computed.match(/[\d.]+/g) || [0, 0, 0]).map(Number);
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  const css = ([r, g, b, a = 1]) =>
    a < 1 ? `rgba(${r},${g},${b},${+a.toFixed(3)})` : `rgb(${r},${g},${b})`;
  const mix = (from, to, amount) =>
    [0, 1, 2].map((i) => Math.round(from[i] + (to[i] - from[i]) * amount));
  const luminance = (color) => {
    const [r, g, b] = color.slice(0, 3).map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };
  // Nudges a color toward `toward` until it reads against `background`.
  const legible = (color, background, toward, minimum = 2.6) => {
    let result = color;
    for (
      let step = 1;
      step <= 10 && contrast(result, background) < minimum;
      step++
    )
      result = mix(color, toward, step / 10);
    return result;
  };

  function palette(root) {
    const get = (name) => rgba(`var(${name})`, root);
    const surface = get("--dk-surface");
    const textColor = get("--dk-text");
    return {
      root,
      font: getComputedStyle(root).fontFamily,
      surface,
      text: textColor,
      muted: get("--dk-muted"),
      border: get("--dk-border"),
      subtle: get("--dk-border-subtle"),
      accent: legible(get("--dk-accent"), surface, textColor),
      series: [1, 2, 3, 4, 5, 6].map((index) =>
        legible(get(`--dk-chart-${index}`), surface, textColor)
      ),
    };
  }

  function chartTheme(c) {
    const text = css(c.text);
    const muted = css(c.muted);
    const border = css(c.border);
    const subtle = css(c.subtle);
    const surface = css(c.surface);
    const axis = (category) => ({
      axisLine: { show: category, lineStyle: { color: border } },
      axisTick: { show: false },
      axisLabel: { color: muted, margin: 10 },
      splitLine: {
        show: !category,
        lineStyle: { color: subtle, type: [3, 4] },
      },
      nameTextStyle: { color: muted },
    });
    return {
      color: c.series.map(css),
      backgroundColor: "transparent",
      textStyle: { color: text, fontFamily: c.font, fontSize: 12 },
      title: {
        textStyle: { color: text, fontWeight: 600, fontSize: 14 },
        subtextStyle: { color: muted },
      },
      legend: {
        top: "bottom",
        icon: "roundRect",
        itemWidth: 10,
        itemHeight: 10,
        itemGap: 18,
        textStyle: { color: muted },
      },
      grid: { top: 24, right: 20, bottom: 40, left: 12, containLabel: true },
      categoryAxis: axis(true),
      valueAxis: axis(false),
      logAxis: axis(false),
      timeAxis: axis(false),
      tooltip: {
        backgroundColor: surface,
        borderColor: border,
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: text, fontSize: 12 },
        extraCssText:
          "border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.08);",
        axisPointer: {
          lineStyle: { color: border },
          crossStyle: { color: border },
          shadowStyle: { color: css([...c.accent, 0.06]) },
        },
      },
      line: { symbol: "circle", symbolSize: 6, lineStyle: { width: 2 } },
      bar: { barMaxWidth: 28, barCategoryGap: "40%" },
      pie: {
        itemStyle: { borderColor: surface, borderWidth: 2 },
        label: { color: muted },
        labelLine: { lineStyle: { color: border } },
      },
      gauge: {
        progress: { show: true, width: 12, roundCap: true },
        axisLine: {
          roundCap: true,
          lineStyle: { width: 12, color: [[1, subtle]] },
        },
        pointer: { show: false },
        anchor: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        title: { color: muted },
        detail: {
          color: text,
          fontSize: 28,
          fontWeight: 600,
          offsetCenter: [0, 0],
        },
      },
      funnel: { gap: 2, label: { color: text } },
      tree: {
        left: "18%",
        right: "22%",
        symbolSize: 8,
        label: { color: text, position: "left", align: "right", distance: 8 },
        leaves: { label: { position: "right", align: "left" } },
        lineStyle: { color: border },
        itemStyle: { color: css(c.accent), borderColor: css(c.accent) },
      },
      heatmap: {
        itemStyle: { borderColor: surface, borderWidth: 2, borderRadius: 4 },
        label: { fontSize: 11 },
      },
      visualMap: {
        textStyle: { color: muted, fontSize: 11 },
        itemWidth: 10,
        itemHeight: 120,
      },
    };
  }

  // Heatmaps use a square-root ramp so a single outlier does not wash out the
  // rest of the grid, and each cell label picks the more readable text color.
  function heatmap(series, option, c) {
    const visualMap = [].concat(option.visualMap || [])[0];
    const cellValue = (item) =>
      Array.isArray(item)
        ? item[2]
        : Array.isArray(item?.value)
          ? item.value[2]
          : null;
    const values = (series.data || []).map(cellValue).filter(Number.isFinite);
    if (
      !visualMap ||
      visualMap.inRange ||
      visualMap.type === "piecewise" ||
      !values.length
    )
      return series;
    const min = visualMap.min ?? Math.min(...values);
    const span = (visualMap.max ?? Math.max(...values)) - min || 1;
    const low = mix(c.surface, c.accent, 0.07);
    const ramp = (t) =>
      mix(low, c.accent, Math.sqrt(Math.min(1, Math.max(0, t))));
    const mapped = {
      ...visualMap,
      inRange: { color: Array.from({ length: 9 }, (_, i) => css(ramp(i / 8))) },
    };
    option.visualMap = Array.isArray(option.visualMap)
      ? [mapped, ...option.visualMap.slice(1)]
      : mapped;
    if (!series.label?.show) return series;
    const faint = mix(c.muted, c.surface, 0.3);
    return {
      ...series,
      data: series.data.map((item) => {
        const value = cellValue(item);
        if (!Number.isFinite(value)) return item;
        const fill = ramp((value - min) / span);
        const color =
          value === 0
            ? faint
            : contrast(c.text, fill) >= contrast(c.surface, fill)
              ? c.text
              : c.surface;
        return Array.isArray(item)
          ? { value: item, label: { color: css(color) } }
          : { ...item, label: { ...item.label, color: css(color) } };
      }),
    };
  }

  function enhance(option, c) {
    const series = [].concat(option.series ?? []);
    if (!series.length) return option;
    const result = { ...option };
    const types = series.map((item) => item?.type);
    const cartesian = option.xAxis != null || option.yAxis != null;
    const horizontal = []
      .concat(option.yAxis ?? [])
      .some((axis) => axis?.type === "category");
    const lines = types.filter((type) => type === "line").length;
    // Colors may be CSS tokens, e.g. "var(--dk-negative)".
    const token = (value) =>
      typeof value === "string" && value.includes("var(")
        ? css(rgba(value, c.root))
        : value;
    const withTokens = (item) => {
      const next = { ...item };
      if (item.color !== undefined) next.color = token(item.color);
      ["itemStyle", "lineStyle", "areaStyle"].forEach((key) => {
        if (item[key]?.color)
          next[key] = { ...item[key], color: token(item[key].color) };
      });
      return next;
    };
    if (Array.isArray(option.color)) result.color = option.color.map(token);
    if (result.tooltip === undefined)
      result.tooltip =
        cartesian && types.every((type) => type === "line" || type === "bar")
          ? {
              trigger: "axis",
              axisPointer: {
                type: types.every((type) => type === "bar") ? "shadow" : "line",
              },
            }
          : { trigger: "item" };
    result.series = series.map((raw, index) => {
      if (!raw || typeof raw !== "object") return raw;
      const item = withTokens(raw);
      if (item.type === "heatmap") return heatmap(item, result, c);
      if (item.type === "line") {
        const next = { ...item };
        if (next.showSymbol === undefined)
          next.showSymbol =
            (Array.isArray(item.data) ? item.data.length : 0) <= 12;
        if (next.areaStyle === undefined && lines <= 2 && !item.stack) {
          const own =
            item.itemStyle?.color || item.lineStyle?.color || item.color;
          const base =
            typeof own === "string"
              ? rgba(own)
              : c.series[index % c.series.length];
          next.areaStyle = {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: css([...base.slice(0, 3), 0.18]) },
                { offset: 1, color: css([...base.slice(0, 3), 0]) },
              ],
            },
          };
        }
        return next;
      }
      if (
        item.type === "bar" &&
        !item.stack &&
        item.itemStyle?.borderRadius === undefined
      )
        return {
          ...item,
          itemStyle: {
            ...item.itemStyle,
            borderRadius: horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0],
          },
        };
      return item;
    });
    return result;
  }

  const observed = new WeakSet();
  function chart(target, option) {
    const root = find(target);
    if (!root) throw new Error("Dashboard Kit target not found");
    if (!global.echarts)
      return notice(root, "Chart unavailable: load echarts.js before kit.js.");
    try {
      const colors = palette(root);
      global.echarts.registerTheme("dashboard-kit", chartTheme(colors));
      let instance = global.echarts.getInstanceByDom(root);
      if (!instance) {
        root.replaceChildren();
        instance = global.echarts.init(root, "dashboard-kit", {
          renderer: "svg",
        });
      }
      instance.setOption(enhance(option, colors), true);
      if (global.ResizeObserver && !observed.has(root)) {
        observed.add(root);
        new global.ResizeObserver(() =>
          global.echarts.getInstanceByDom(root)?.resize()
        ).observe(root);
      }
      return instance;
    } catch (error) {
      global.console?.error(error);
      global.echarts.getInstanceByDom(root)?.dispose();
      return notice(root, `Chart error: ${error.message}`);
    }
  }

  const api = {
    kpi,
    kpis,
    table,
    list,
    tabs,
    filters,
    segmented,
    callout,
    pill,
    sparkline,
    format,
    md,
    csv,
    downloadCsv,
    chart,
    locale: undefined,
    version: "2",
  };
  global.DashboardKit = api;
})(globalThis);
