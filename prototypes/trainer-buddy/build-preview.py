"""Bundle the prototype into one offline HTML file (standard library only)."""
from pathlib import Path

root = Path(__file__).resolve().parent
html = (root / 'agent.html').read_text(encoding='utf-8')
css = (root / 'agent.css').read_text(encoding='utf-8')
js = (root / 'agent.js').read_text(encoding='utf-8')
(root / 'index.html').write_text(html, encoding='utf-8')
html = html.replace('<link rel="stylesheet" href="agent.css">', f'<style>\n{css}\n</style>')
html = html.replace('<script src="agent.js"></script>', f'<script>\n{js}\n</script>')
(root / 'preview.html').write_text(html, encoding='utf-8')
print('Created prototypes/trainer-buddy/preview.html')
