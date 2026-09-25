import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownAssetsContext, MarkdownView } from '../../src/web/markdown/MarkdownView';

function render(md: string, assets?: Parameters<typeof MarkdownAssetsContext.Provider>[0]['value']) {
  const view = <MarkdownView source={md} />;
  return renderToStaticMarkup(assets ? <MarkdownAssetsContext.Provider value={assets}>{view}</MarkdownAssetsContext.Provider> : view);
}


const ASSET = '0b7f7b9e-4f5d-4c1e-9a6e-2b8f4c1d9e10';

describe('基础 Markdown、公式、中文', () => {
  it('列表、引用、表格、代码块、链接、图片正常', () => {
    const html = render(
      [
        '# 标题',
        '',
        '- 列表一',
        '- 列表二',
        '',
        '> 普通引用',
        '',
        '| 列 | 值 |',
        '| --- | --- |',
        '| a | 1 |',
        '',
        '```js',
        'const x = 1;',
        '```',
        '',
        '[链接](https://example.com)',
        '',
        `![示意图](assets/${ASSET}.png)`,
      ].join('\n'),
    );
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<li>列表一</li>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<table>');
    expect(html).toContain('<code class="language-js">const x = 1;');
    expect(html).toContain('href="https://example.com" target="_blank" rel="noopener noreferrer nofollow"');
    expect(html).toContain(`src="/api/assets/${ASSET}"`);
  });

  it('单独成段的一行 $$...$$ 按块级公式显示；段落中的仍为行内', () => {
    expect(render('$$E=mc^2$$')).toContain('katex-display');
    const inline = render('文字 $$E=mc^2$$ 文字');
    expect(inline).toContain('class="katex"');
    expect(inline).not.toContain('katex-display');
  });

  it('行内与块级公式由 KaTeX 渲染', () => {
    const html = render('中文里有 $x^2+y^2=1$ 公式\n\n$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$');
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
    expect(html).toContain('中文里有');
  });
});

describe('callout：自定义标题、大小写、+/- 折叠、嵌套、未知类型回退', () => {
  it('自定义标题可含基本 Markdown', () => {
    const html = render('> [!tip] 换元 **提醒**\n> 先令 $t=x^2$，再检查取值范围。');
    expect(html).toContain('data-callout="tip"');
    expect(html).toMatch(/callout-title-text">换元 <strong>提醒<\/strong>/);
    expect(html).toContain('class="katex"');
  });

  it('类型标识大小写兼容；无标题时使用默认标题', () => {
    for (const marker of ['[!WARNING]', '[!Warning]', '[!warning]']) {
      const html = render(`> ${marker}\n> 内容`);
      expect(html, marker).toContain('data-callout="warning"');
      expect(html).toContain('注意');
    }
  });

  it('+ 默认展开，- 默认折叠', () => {
    const open = render('> [!answer]+ 参考答案\n> 42');
    expect(open).toMatch(/<details[^>]*data-callout="answer"[^>]*open=""/);
    const closed = render('> [!answer]- 展开参考答案\n> 42');
    expect(closed).toMatch(/<details[^>]*data-callout="answer"/);
    expect(closed).not.toMatch(/<details[^>]*open/);
    // 折叠只影响阅读：内容仍在输出中
    expect(closed).toContain('42');
    const plain = render('> [!answer] 答\n> 42');
    expect(plain).not.toContain('<details');
  });

  it('嵌套 callout', () => {
    const html = render(['> [!note] 解题过程', '> 第一种思路。', '>', '> > [!warning] 易漏条件', '> > 注意变量的定义域。'].join('\n'));
    expect(html).toContain('data-callout="note"');
    expect(html).toContain('data-callout="warning"');
    expect(html.indexOf('data-callout="note"')).toBeLessThan(html.indexOf('data-callout="warning"'));
    expect(html).toContain('易漏条件');
  });

  it('常见别名', () => {
    for (const t of ['hint', 'faq', 'done', 'caution', 'error', 'cite', 'tldr']) {
      expect(render(`> [!${t}]\n> x`), t).toContain(`data-callout="${t}"`);
    }
  });

  it('未知类型使用通用样式，但保留原始类型文本', () => {
    const html = render('> [!Mistake]\n> 我常犯的错');
    expect(html).toContain('data-callout="unknown-type"');
    expect(html).toContain('data-callout-type="Mistake"');
    expect(html).toMatch(/callout-title-text">\s*Mistake/);
    const titled = render('> [!mistake]- 自定义标题\n> 内容');
    expect(titled).toContain('data-callout-type="mistake"');
    expect(titled).toContain('自定义标题');
    expect(titled).toContain('<details');
    const inlineTitle = render('> [!mistake] **加粗** 标题\n> 内容');
    expect(inlineTitle).toMatch(/callout-title-text"><strong>加粗<\/strong> 标题/);
  });

  it('[!xxx] 不在段首时不是 callout', () => {
    const html = render('> 这里提到 [!tip] 只是文字\n> 第二行');
    expect(html).not.toContain('data-callout');
    expect(html).toContain('<blockquote>');
  });
});

describe('callout 内公式、代码与本地图片；代码中的 callout 示例不被误渲染', () => {
  it('callout 内容', () => {
    const html = render(
      ['> [!solution] 解法', '> $$a^2+b^2=c^2$$', '>', '> ```python', '> print(1)', '> ```', '>', `> ![图](assets/${ASSET}.png)`].join('\n'),
    );
    expect(html).toContain('data-callout="solution"');
    expect(html).toContain('katex-display');
    expect(html).toContain('<code class="language-python">print(1)');
    expect(html).toContain(`/api/assets/${ASSET}`);
  });

  it('代码块中的 callout 语法原样显示', () => {
    const html = render('```markdown\n> [!tip] 示例\n> 内容\n```\n\n`> [!note]`');
    expect(html).not.toContain('data-callout');
    expect(html).toContain('&gt; [!tip] 示例');
  });
});

describe('不支持的公式或语法保留原文并给出反馈', () => {
  it('KaTeX 不支持的命令显示原文与错误提示，不抛异常', () => {
    const html = render('能渲染 $x$，不能渲染 $\\foobarcmd{x}$ 和 $$\\begin{tikzpicture}\\end{tikzpicture}$$');
    expect(html).toContain('class="katex"');
    expect(html).toContain('katex-error');
    expect(html).toContain('\\foobarcmd{x}');
    expect(html).toContain('tikzpicture');
  });

  it('原始 HTML 以文字显示，不执行；危险链接被过滤', () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[点我](javascript:alert(1))');
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/<img[^>]*onerror/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
  });

  it('Obsidian 双链、附件嵌入保留原文（不宣称支持）', () => {
    const html = render('见 [[另一道题]] 与 ![[图.png]]');
    expect(html).toContain('[[另一道题]]');
    expect(html).toContain('![[图.png]]');
  });
});

describe('图片来源受控', () => {
  it('远程图片默认不回退到外链，只显示占位与原 URL', () => {
    const html = render('![远程](https://img.example.com/a.png)');
    expect(html).not.toMatch(/<img[^>]*src="https:/);
    expect(html).toContain('https://img.example.com/a.png');
    expect(html).toContain('远程图片');
  });

  it('已归档的远程图片显示本地副本；失败的显示原因', () => {
    const url = 'https://img.example.com/a.png';
    const assets = {
      remoteImageUrls: { [url]: 'r1', 'https://x/fail.png': 'r2' },
      remoteImages: {
        r1: { id: 'r1', url, status: 'archived' as const, assetId: ASSET, archivedVia: 'download' as const, errorCode: null, errorMessage: null, attempts: 1, updatedAt: '' },
        r2: { id: 'r2', url: 'https://x/fail.png', status: 'failed' as const, assetId: null, archivedVia: null, errorCode: 'DOWNLOAD_FAILED', errorMessage: 'HTTP 404', attempts: 1, updatedAt: '' },
      },
    };
    const html = render(`![a](${url})\n\n![b](https://x/fail.png)`, assets);
    expect(html).toContain(`src="/api/assets/${ASSET}"`);
    expect(html).toContain('远程图片未归档');
    expect(html).toContain('HTTP 404');
  });

  it('缺失的本地相对图片明确提示，不读取本机路径', () => {
    const html = render('![本地](./img/a.png)\n\n![绝对](/etc/passwd)\n\n![文件](file:///etc/passwd)');
    expect(html).not.toMatch(/<img/);
    expect((html.match(/本地图片缺失/g) ?? []).length).toBe(3);
  });
});
