(function (global) {
  "use strict";

  const { document, URL, Blob, getComputedStyle } = global;
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

  function kpi(target, options) {
    const card = node("section", "dk-card dk-kpi");
    card.append(
      node("span", "dk-label", options.label),
      node("strong", "dk-value", options.value)
    );
    if (options.delta != null) {
      const delta = node("span", "dk-delta", options.delta);
      delta.dataset.direction = options.direction || "neutral";
      card.append(delta);
    }
    return mount(target, card);
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

  function table(target, options) {
    const root = node("section", "dk-table-wrap");
    const toolbar = node("div", "dk-toolbar");
    const search = node("input", "dk-search");
    search.type = "search";
    search.placeholder = "Search";
    const exportButton = node("button", "dk-button", "Export CSV");
    toolbar.append(search, exportButton);
    const tableNode = node("table", "dk-table");
    root.append(toolbar, tableNode);
    let rows = [...options.rows];
    let sortKey;
    let ascending = true;
    const render = () => {
      const query = search.value.toLowerCase();
      let visible = rows.filter((row) =>
        Object.values(row).some((value) =>
          text(value).toLowerCase().includes(query)
        )
      );
      if (sortKey)
        visible = [...visible].sort(
          (a, b) =>
            text(a[sortKey]).localeCompare(text(b[sortKey]), undefined, {
              numeric: true,
            }) * (ascending ? 1 : -1)
        );
      const head = node("thead");
      const headRow = node("tr");
      options.columns.forEach((column) => {
        const header = node("th", null, column.label || column.key);
        header.tabIndex = 0;
        header.addEventListener("click", () => {
          ascending = sortKey === column.key ? !ascending : true;
          sortKey = column.key;
          render();
        });
        headRow.append(header);
      });
      head.append(headRow);
      const body = node("tbody");
      visible.forEach((row) => {
        const tr = node("tr");
        options.columns.forEach((column) =>
          tr.append(node("td", null, row[column.key]))
        );
        body.append(tr);
      });
      tableNode.replaceChildren(head, body);
    };
    search.addEventListener("input", render);
    exportButton.addEventListener("click", () =>
      downloadCsv(options.filename, rows, options.columns)
    );
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
      if (item.value != null) li.append(node("strong", null, item.value));
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
    if (!global.marked || !global.DOMPurify)
      throw new Error("Load marked.js and purify.js before kit.js");
    const root = node("article", "dk-markdown");
    root.innerHTML = global.DOMPurify.sanitize(global.marked.parse(markdown));
    return mount(target, root);
  }

  function chart(target, option) {
    if (!global.echarts) throw new Error("Load echarts.js before kit.js");
    const styles = getComputedStyle(document.documentElement);
    const color = (name) => styles.getPropertyValue(name).trim();
    global.echarts.registerTheme("dashboard-kit", {
      color: [
        color("--dk-accent"),
        color("--dk-positive"),
        color("--dk-negative"),
        "#8b5cf6",
        "#e8a23a",
      ],
      backgroundColor: "transparent",
      textStyle: { color: color("--dk-text") },
      title: { textStyle: { color: color("--dk-text") } },
      legend: { textStyle: { color: color("--dk-muted") } },
      categoryAxis: {
        axisLabel: { color: color("--dk-muted") },
        axisLine: { lineStyle: { color: color("--dk-border") } },
      },
      valueAxis: {
        axisLabel: { color: color("--dk-muted") },
        axisLine: { lineStyle: { color: color("--dk-border") } },
      },
      gauge: {
        axisLabel: { color: color("--dk-muted") },
        detail: { color: color("--dk-text") },
      },
      funnel: { label: { color: color("--dk-text") } },
      tree: { label: { color: color("--dk-text") } },
      visualMap: { textStyle: { color: color("--dk-text") } },
    });
    const instance = global.echarts.init(find(target), "dashboard-kit", {
      renderer: "svg",
    });
    instance.setOption(option);
    if (global.ResizeObserver) {
      const observer = new global.ResizeObserver(() => instance.resize());
      observer.observe(find(target));
    }
    return instance;
  }

  global.DashboardKit = {
    kpi,
    table,
    list,
    tabs,
    filters,
    md,
    csv,
    downloadCsv,
    chart,
    version: "1",
  };
})(globalThis);
