import csv, datetime, html, pathlib

src = pathlib.Path(r'C:\Users\dodyg\AppData\Local\Temp\browser-use\exports\UNDP Albania Supreme Court Roadmap-63929373-b7ed-4b68-88a4-b2a151b43979.csv')
out = pathlib.Path(r'S:\GitHub\last-line\tmp\pdfs\roadmap.html')
rows = list(csv.reader(src.open(encoding='utf-8-sig', newline='')))
header = rows[4]
records = []
sections = []
for row in rows[5:]:
    row += [''] * (len(header) - len(row))
    d = dict(zip(header, row))
    ident = d.get('ID', '').strip()
    if ident.isdigit() and d.get('Task', '').strip():
        sections.append({'name': d['Task'].strip(), 'tasks': []})
    elif ident and '.' in ident and d.get('Task', '').strip():
        try:
            start = datetime.datetime.strptime(d['Start'].strip() + ' 2026', '%d %b %Y').date()
            end = datetime.datetime.strptime(d['End'].strip() + ' 2026', '%d %b %Y').date()
        except ValueError:
            continue
        sections[-1]['tasks'].append({'title': d['Task'].strip(), 'status':d['Status'].strip(), 'start':start, 'end':end, 'notes':d.get('Notes / dependency','').strip()})

W=1812; left=165; right=32; plot=W-left-right; day0=datetime.date(2026,10,18); dayN=datetime.date(2026,12,20); total=(dayN-day0).days
scale=plot/total
colors=['#075985','#15803d','#1d4ed8','#86198f','#a16207','#b91c1c']
def esc(s): return html.escape(s, quote=True)
def tx(x,y,s,size=10,fill='#263247',weight='normal',anchor='start',extra=''):
    return f'<text x="{x:.1f}" y="{y:.1f}" font-family="Arial,sans-serif" font-size="{size}" fill="{fill}" font-weight="{weight}" text-anchor="{anchor}" {extra}>{esc(s)}</text>'

top=64; axis_h=38; header_h=43; lane_gap=8
# Give every task its own row so labels remain easy to scan.
for sec in sections:
    for lane,task in enumerate(sec['tasks']): task['lane']=lane
    sec['height']=max(42, len(sec['tasks'])*18+12)
H=top+axis_h+sum(s['height']+lane_gap for s in sections)+26
outsvg=[]
outsvg.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
outsvg.append('<rect width="100%" height="100%" fill="#ffffff"/>')
outsvg.append(tx(W/2,25,'UNDP Albania Supreme Court | Roadmap · 29 Oct to 10 Dec 2026',16,'#172033','bold','middle'))
outsvg.append(tx(W/2,43,'Solid bars = done  ·  outlined = to do  ·  dotted = needs input  ·  diamond = milestone / checkpoint',10,'#43536b','normal','middle'))
# date grid, weekly ticks and weekend shading
for i in range(total):
    date=day0+datetime.timedelta(days=i)
    x=left+i*scale
    if date.weekday() in (4,5): outsvg.append(f'<rect x="{x:.1f}" y="{top}" width="{scale+0.5:.1f}" height="{H-top-10}" fill="#eef0f3"/>')
for i in range(0,total+1,7):
    date=day0+datetime.timedelta(days=i); x=left+i*scale
    outsvg.append(f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{H-10}" stroke="#aab3c0" stroke-width="0.8"/>')
    outsvg.append(tx(x+3,top-5,date.strftime('%d %b'),9,'#536174'))
outsvg.append(f'<line x1="{left+plot:.1f}" y1="{top}" x2="{left+plot:.1f}" y2="{H-10}" stroke="#aab3c0" stroke-width="0.8"/>')
# report date line
today=datetime.date(2026,10,29); txpos=left+(today-day0).days*scale
outsvg.append(f'<line x1="{txpos:.1f}" y1="{top-11}" x2="{txpos:.1f}" y2="{H-8}" stroke="#c62828" stroke-width="2.5"/>')
y=top+axis_h
for ix,sec in enumerate(sections):
    color=colors[ix%len(colors)]
    if ix%2==0: outsvg.append(f'<rect x="5" y="{y:.1f}" width="{W-10}" height="{sec["height"]:.1f}" fill="#f3f6fa"/>')
    outsvg.append(tx(14,y+17,sec['name'],11,color,'bold'))
    outsvg.append(f'<line x1="5" y1="{y+sec["height"]:.1f}" x2="{W-5}" y2="{y+sec["height"]:.1f}" stroke="#d7dde5" stroke-width="0.7"/>')
    for task in sec['tasks']:
        yy=y+17+task['lane']*20; x=left+(task['start']-day0).days*scale; x2=left+((task['end']-day0).days+1)*scale
        status=task['status'].lower()
        if 'milestone' in sec['name'].lower() or 'checkpoint' in sec['name'].lower():
            cx=(x+x2)/2; outsvg.append(f'<path d="M {cx:.1f} {yy-6:.1f} l 6 6 l -6 6 l -6 -6 z" fill="{color}"/>')
            label=task['title']; outsvg.append(tx(cx+10,yy+3,label,9,color,'bold'))
        else:
            dash=' stroke-dasharray="2,2"' if 'needs input' in status else ''
            fill=color if 'done' in status else '#ffffff'
            opacity='0.2' if 'done' not in status else '1'
            outsvg.append(f'<rect x="{x:.1f}" y="{yy-7:.1f}" width="{max(5,x2-x-1):.1f}" height="14" rx="3" fill="{color}" fill-opacity="{opacity}" stroke="{color}" stroke-width="1.5"{dash}/>')
            label=task['title']
            lx=x2+5
            if lx>W-130: lx=x-4; anchor='end'
            else: anchor='start'
            outsvg.append(tx(lx,yy+3,label,8.5,color,'normal',anchor))
            if task['notes']:
                outsvg.append(tx(min(W-8,x2+5),yy+12,task['notes'],7.5,'#596579'))
    y+=sec['height']+lane_gap
outsvg.append('</svg>')
svg=''.join(outsvg)
html_doc=f'''<!doctype html><html><head><meta charset="utf-8"><style>@page{{size:{W/72:.3f}in {H/72:.3f}in;margin:0}}html,body{{margin:0;padding:0;width:{W}pt;height:{H}pt}}svg{{display:block;width:{W}pt;height:{H}pt}}</style></head><body>{svg}</body></html>'''
out.write_text(html_doc,encoding='utf-8')
print(out)
