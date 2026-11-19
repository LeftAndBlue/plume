export const WELCOME = `# 墨行 Markline

一个**所见即所得**的 Markdown 编辑器：源码就是文档，渲染只是视图。光标走到哪里，哪里的标记就会显形。

> 左侧是大纲，右下角是字数。试试用快捷键 \`Ctrl+1\` 到 \`Ctrl+3\` 切换标题层级。

[toc]

## 基础排版

支持 **加粗**、*斜体*、~~删除线~~、\`行内代码\`，以及 [链接](https://commonmark.org)。

行内公式：质能方程 $E = mc^2$，欧拉恒等式 $e^{i\\pi} + 1 = 0$。

## 列表

- 无序列表项
- 第二项，含 \`inline code\`
- 第三项
  - 缩进一级的子项，圆点换字形
    - 再缩进一级
  - 同级子项

1. 有序列表第一项
2. 第二项
3. 第三项
   1. 子项编号从 1 起
   1. 源码写 1，渲染成 2

### 任务清单（可直接点选）

- [x] 打通实时预览渲染
- [x] 原子块点击进入编辑
- [ ] 补上导出模板
- [ ] 做移动端适配

## 代码块

\`\`\`js
function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
\`\`\`

\`\`\`python
def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
\`\`\`

## 表格

| 能力 | Typora | 本编辑器 |
| :--- | :---: | ---: |
| 实时预览 | 有 | 有 |
| 主题层叠 | 四层 | 四层 |
| 表格渲染 | 有 | 有 |
| 格子里写 \`code\` / **粗体** | 有 | 有 |

## 公式块

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

---

## 图片

![示意图](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1NjAiIGhlaWdodD0iMTUwIj48cmVjdCB3aWR0aD0iNTYwIiBoZWlnaHQ9IjE1MCIgcng9IjEwIiBmaWxsPSIjZWVmMmZmIi8+PHRleHQgeD0iMjgwIiB5PSI3MiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9InNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjAiIGZpbGw9IiMzMzQxNTUiPuWbvueJh+S7peWOn+WtkOWdl+a4suafkzwvdGV4dD48dGV4dCB4PSIyODAiIHk9IjEwNCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9InNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTMiIGZpbGw9IiM2NDc0OGIiPueCueWHu+WPr+ebtOaOpeWbnuWIsOa6kOeggTwvdGV4dD48L3N2Zz4=)

## 引用与说明

> 静态分析得到的结论只是「行为的重建」，不等于原始实现。
> 但足够用来做一次干净的重新设计。
`;
