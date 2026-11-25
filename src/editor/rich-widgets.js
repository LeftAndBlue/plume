import { WidgetType } from '@codemirror/view';
import { footnoteDef } from './rich-doc.js';

let mermaidPromise = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', fontFamily: 'inherit' });
      return mermaid;
    });
  }
  return mermaidPromise;
}

let mermaidSeq = 0;

export class MermaidWidget extends WidgetType {
  constructor(code, from) {
    super();
    this.code = code;
    this.from = from;
    this.theme = document.body.dataset.mode === 'dark' ? 'dark' : 'light';
  }
  eq(other) {
    return other.code === this.code && other.from === this.from && other.theme === this.theme;
  }
  toDOM(view) {
    const el = document.createElement('div');
    el.className = 'cm-mermaid';
    el.textContent = '正在绘制图表…';
    const dark = document.body.dataset.mode === 'dark';
    const id = 'mmd-' + ++mermaidSeq;
    loadMermaid()
      .then((mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default',
          fontFamily: 'inherit',
        });
        // 必须传入离屏容器：否则 Mermaid 会在 body 下自行创建一个 div 来渲染。
        // body 是 flex 列容器，那个临时 div 会占据文档流、压缩 #app，
        // 表现为滚动经过流程图时状态栏上移、窗口底部多出一块空白。
        const scratch = document.createElement('div');
        scratch.style.cssText =
          'position:fixed;left:-10000px;top:0;width:1000px;visibility:hidden;pointer-events:none;';
        document.body.appendChild(scratch);
        return mermaid
          .render(id, this.code, scratch)
          .finally(() => scratch.remove());
      })
      .then(({ svg }) => {
        if (!el.isConnected) return;
        el.innerHTML = svg;
      })
      .catch((err) => {
        el.classList.add('is-broken');
        el.textContent = '图表没有画出来：' + (err && err.message ? err.message : err);
      });
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

export class FrontMatterWidget extends WidgetType {
  constructor(fields, from) {
    super();
    this.fields = fields;
    this.from = from;
  }
  eq(other) {
    return JSON.stringify(other.fields) === JSON.stringify(this.fields);
  }
  toDOM(view) {
    const el = document.createElement('div');
    el.className = 'cm-frontmatter';
    const title = document.createElement('div');
    title.className = 'cm-frontmatter-title';
    title.textContent = '文首信息';
    el.appendChild(title);
    if (!this.fields.length) {
      const empty = document.createElement('div');
      empty.className = 'cm-frontmatter-empty';
      empty.textContent = '还没有字段';
      el.appendChild(empty);
    } else {
      for (const field of this.fields) {
        const row = document.createElement('div');
        row.className = 'cm-frontmatter-row';
        const key = document.createElement('span');
        key.textContent = field.key;
        const value = document.createElement('span');
        value.textContent = field.value || '—';
        row.append(key, value);
        el.appendChild(row);
      }
    }
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

export class FootnoteRefWidget extends WidgetType {
  constructor(id) {
    super();
    this.id = id;
  }
  eq(other) {
    return other.id === this.id;
  }
  toDOM(view) {
    const el = document.createElement('sup');
    el.className = 'cm-fn-ref';
    el.textContent = this.id;
    el.title = '跳到脚注 ' + this.id;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const doc = view.state.doc;
      for (let n = 1; n <= doc.lines; n++) {
        const def = footnoteDef(doc.line(n).text);
        if (def && def.id === this.id) {
          const pos = doc.line(n).from;
          view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
          view.focus();
          return;
        }
      }
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

export class FootnoteDefWidget extends WidgetType {
  constructor(id, text, from) {
    super();
    this.id = id;
    this.text = text;
    this.from = from;
  }
  eq(other) {
    return other.id === this.id && other.text === this.text;
  }
  toDOM(view) {
    const el = document.createElement('div');
    el.className = 'cm-fn-def';
    const mark = document.createElement('sup');
    mark.textContent = this.id;
    const body = document.createElement('span');
    body.textContent = this.text || '（空脚注）';
    el.append(mark, body);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}
