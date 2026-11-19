import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';

// 只注册语言菜单实际提供的语言。完整 @codemirror/language-data 会把数百个动态 chunk
// 全部带进安装包；这里仍使用 import()，只有遇到对应代码围栏时才加载语法。
const legacy = (parser) => new LanguageSupport(StreamLanguage.define(parser));
const describe = (name, load, alias = []) => LanguageDescription.of({ name, alias, load });

export const codeLanguages = [
  describe('JavaScript', () => import('@codemirror/lang-javascript').then((m) => m.javascript()), ['ecmascript', 'js', 'node']),
  describe('TypeScript', () => import('@codemirror/lang-javascript').then((m) => m.typescript()), ['ts']),
  describe('Python', () => import('@codemirror/lang-python').then((m) => m.python())),
  describe('Java', () => import('@codemirror/lang-java').then((m) => m.java())),
  describe('C', () => import('@codemirror/lang-cpp').then((m) => m.cpp())),
  describe('C++', () => import('@codemirror/lang-cpp').then((m) => m.cpp()), ['cpp']),
  describe('C#', () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.csharp)), ['csharp', 'cs']),
  describe('Go', () => import('@codemirror/lang-go').then((m) => m.go())),
  describe('Rust', () => import('@codemirror/lang-rust').then((m) => m.rust())),
  describe('PHP', () => import('@codemirror/lang-php').then((m) => m.php())),
  describe('Ruby', () => import('@codemirror/legacy-modes/mode/ruby').then((m) => legacy(m.ruby)), ['rb']),
  describe('Swift', () => import('@codemirror/legacy-modes/mode/swift').then((m) => legacy(m.swift))),
  describe('Kotlin', () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.kotlin)), ['kt']),
  describe('SQL', () => import('@codemirror/lang-sql').then((m) => m.sql({ dialect: m.StandardSQL }))),
  describe('Shell', () => import('@codemirror/legacy-modes/mode/shell').then((m) => legacy(m.shell)), ['bash', 'sh', 'zsh']),
  describe('PowerShell', () => import('@codemirror/legacy-modes/mode/powershell').then((m) => legacy(m.powerShell)), ['ps1']),
  describe('HTML', () => import('@codemirror/lang-html').then((m) => m.html()), ['xhtml']),
  describe('CSS', () => import('@codemirror/lang-css').then((m) => m.css())),
  describe('SCSS', () => import('@codemirror/lang-sass').then((m) => m.sass())),
  describe('JSON', () => import('@codemirror/lang-json').then((m) => m.json()), ['json5']),
  describe('YAML', () => import('@codemirror/lang-yaml').then((m) => m.yaml()), ['yml']),
  describe('XML', () => import('@codemirror/lang-xml').then((m) => m.xml())),
  describe('Markdown', () => import('@codemirror/lang-markdown').then((m) => m.markdown()), ['md']),
  describe('Diff', () => import('@codemirror/legacy-modes/mode/diff').then((m) => legacy(m.diff))),
  describe('Dockerfile', () => import('@codemirror/legacy-modes/mode/dockerfile').then((m) => legacy(m.dockerFile)), ['docker']),
];

/** 把围栏别名归一成菜单使用的语言名；未知的手动输入保留原值并退化为纯文本。 */
export function canonicalLanguage(value) {
  const v = (value || '').trim().toLowerCase();
  if (!v) return '';
  const d = codeLanguages.find((x) => x.name.toLowerCase() === v || x.alias.includes(v));
  return d ? d.name.toLowerCase() : v;
}
