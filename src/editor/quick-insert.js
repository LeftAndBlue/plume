/**
 * 轻量悬浮快捷菜单：
 * - 行首输入 `/` 呼出块级插入菜单（标题、列表、表格选择器、代码块、流程图、公式、提示框、折叠块等）
 * - 输入 `:keyword` 呼出 Typora 风格的 Emoji 候选
 * - 输入完整闭合 `:smile:` 时自动替换为对应 Emoji
 * 支持 ↑/↓ 切换、Enter/Tab 确认、Esc 关闭及鼠标点击。
 */
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { matchExactEmojiShortcode, matchQuickTrigger } from './extrasText.js';

function inCodeBlock(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'InlineCode') return true;
  }
  return false;
}

const activeMenus = new WeakMap();

function makeQuickInsertPlugin(onCommand) {
  return class QuickInsertPlugin {
    constructor(view) {
      this.view = view;
      this.onCommand = typeof onCommand === 'function' ? onCommand : null;
      this.state = null; // { kind, from, to, items, index }
      this.dismissedAt = null;
      this.el = document.createElement('div');
      this.el.className = 'cm-quick-pop';
      this.el.hidden = true;
      document.body.appendChild(this.el);
      activeMenus.set(view, this);

      this.onDocMouseDown = (e) => {
        if (!this.el.hidden && !this.el.contains(e.target)) this.hide();
      };
      document.addEventListener('mousedown', this.onDocMouseDown, true);
    }

    update(update) {
      if (!update.docChanged && !update.selectionSet && !update.focusChanged) return;
      if (!update.view.hasFocus) {
        this.hide();
        return;
      }
      const sel = update.state.selection.main;
      if (!sel.empty || inCodeBlock(update.state, sel.head)) {
        this.hide();
        return;
      }

      // 刚输入闭合冒号（如 `:smile:`）时自动替换为对应 Emoji
      if (update.docChanged) {
        let typedColon = false;
        update.changes.iterChanges((_fA, _tA, _fB, _tB, inserted) => {
          if (inserted.toString() === ':') typedColon = true;
        });
        if (typedColon) {
          const line = update.state.doc.lineAt(sel.head);
          const exact = matchExactEmojiShortcode(line.text, line.from, sel.head - line.from);
          if (exact) {
            this.hide();
            queueMicrotask(() => {
              if (!this.view.dom.isConnected) return;
              const curDoc = this.view.state.doc;
              if (exact.to <= curDoc.length && curDoc.sliceString(exact.from, exact.to) === `:${exact.code}:`) {
                this.view.dispatch({
                  changes: { from: exact.from, to: exact.to, insert: exact.emoji },
                  selection: { anchor: exact.from + exact.emoji.length },
                  userEvent: 'input.complete',
                });
              }
            });
            return;
          }
        }
      }

      if (this.dismissedAt === sel.head && !update.docChanged) return;
      this.dismissedAt = null;

      const line = update.state.doc.lineAt(sel.head);
      const match = matchQuickTrigger(line.text, line.from, sel.head - line.from);
      if (!match) {
        this.hide();
        return;
      }
      this.state = { ...match, to: sel.head, index: 0 };
      this.render();
      this.position(sel.head);
    }

    render() {
      if (!this.state) return;
      const { kind, items, index } = this.state;
      this.el.textContent = '';
      items.forEach((item, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cm-quick-item' + (i === index ? ' is-active' : '');
        if (kind === 'emoji') {
          const icon = document.createElement('span');
          icon.className = 'cm-quick-icon';
          icon.textContent = item.emoji;
          const label = document.createElement('span');
          label.className = 'cm-quick-label';
          label.textContent = `:${item.code}:`;
          const hint = document.createElement('span');
          hint.className = 'cm-quick-hint';
          hint.textContent = item.label;
          btn.append(icon, label, hint);
        } else {
          const label = document.createElement('span');
          label.className = 'cm-quick-label';
          label.textContent = item.label;
          const hint = document.createElement('span');
          hint.className = 'cm-quick-hint';
          hint.textContent = '/' + item.id;
          btn.append(label, hint);
        }
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.apply(i);
        });
        this.el.appendChild(btn);
      });
      this.el.hidden = false;
      this.el.children[index]?.scrollIntoView({ block: 'nearest' });
    }

    position(pos) {
      const coords = this.view.coordsAtPos(pos);
      if (!coords) {
        this.hide();
        return;
      }
      const pad = 8;
      const maxW = 260;
      const left = Math.min(Math.max(pad, coords.left), window.innerWidth - maxW - pad);
      const estH = Math.min(320, (this.state?.items.length || 4) * 32 + 12);
      const below = coords.bottom + 6;
      const top = below + estH > window.innerHeight - pad ? Math.max(pad, coords.top - estH - 6) : below;
      this.el.style.left = Math.round(left) + 'px';
      this.el.style.top = Math.round(top) + 'px';
    }

    move(delta) {
      if (!this.state || this.el.hidden) return false;
      const len = this.state.items.length;
      this.state.index = (this.state.index + delta + len) % len;
      this.render();
      return true;
    }

    apply(idx = this.state?.index ?? 0) {
      if (!this.state || this.el.hidden) return false;
      const item = this.state.items[idx];
      if (!item) return false;
      const { kind, from, to } = this.state;
      this.hide();

      // 斜杠项若绑定了命令（如 /table 呼出表格行列选择器），先清除触发文本再执行命令
      if (kind === 'slash' && item.command && this.onCommand) {
        this.view.dispatch({
          changes: { from, to, insert: '' },
          selection: { anchor: from },
          scrollIntoView: true,
          userEvent: 'input.complete',
        });
        this.view.focus();
        requestAnimationFrame(() => this.onCommand(item.command));
        return true;
      }

      const insert = kind === 'emoji' ? item.emoji : item.insert;
      const anchor = kind === 'emoji' ? from + insert.length : from + (item.offset ?? insert.length);
      this.view.dispatch({
        changes: { from, to, insert },
        selection: { anchor },
        scrollIntoView: true,
        userEvent: 'input.complete',
      });
      this.view.focus();
      return true;
    }

    hide(markDismissed = false) {
      if (markDismissed) this.dismissedAt = this.view.state.selection.main.head;
      this.state = null;
      this.el.hidden = true;
    }

    destroy() {
      document.removeEventListener('mousedown', this.onDocMouseDown, true);
      activeMenus.delete(this.view);
      this.el.remove();
    }
  };
}

const quickInsertKeys = Prec.highest(
  keymap.of([
    { key: 'ArrowDown', run: (v) => activeMenus.get(v)?.move(1) || false },
    { key: 'ArrowUp', run: (v) => activeMenus.get(v)?.move(-1) || false },
    { key: 'Enter', run: (v) => activeMenus.get(v)?.apply() || false },
    { key: 'Tab', run: (v) => activeMenus.get(v)?.apply() || false },
    {
      key: 'Escape',
      run: (v) => {
        const m = activeMenus.get(v);
        if (!m || !m.state) return false;
        m.hide(true);
        return true;
      },
    },
  ])
);

export function createQuickInsert({ onCommand } = {}) {
  return [quickInsertKeys, ViewPlugin.fromClass(makeQuickInsertPlugin(onCommand))];
}

export const quickInsert = createQuickInsert();
