# Builds calendar/panel/nova.html: the Calendar plugin's original index.html, byte for byte, plus
# Nova's stylesheet link, Nova's tab bar and view container, and Nova's script. Run after updating
# the copied Calendar code:  python3 -I nova/build.py
from pathlib import Path
root = Path(__file__).resolve().parent.parent
src = (root / 'calendar/panel/index.html').read_text()
assert src.count('</head>') == 1 and src.count('<body>') == 1 and src.count('</body>') == 1
out = (src
  .replace('</head>', '    <!-- Nova (added): its own styles, all prefixed nv- -->\n    <link rel="stylesheet" href="../../nova/style.css" />\n  </head>', 1)
  .replace('<body>', '<body>\n    <!-- Nova (added): tab bar and the dashboard/sections; the Calendar markup below is unchanged -->\n    <nav class="nv-tabs" id="nv-tabs" role="tablist" aria-label="Nova"></nav>\n    <div class="nv-view" id="nv-view"></div>', 1)
  .replace('</body>', '    <!-- Nova (added) -->\n    <script type="module" src="../../nova/app.mjs"></script>\n  </body>', 1))
(root / 'calendar/panel/nova.html').write_text(out)
print('wrote calendar/panel/nova.html')
