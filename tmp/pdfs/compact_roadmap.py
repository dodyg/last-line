exec(open(r'S:\GitHub\last-line\tmp\pdfs\build_roadmap.py',encoding='utf-8').read().split('W=1812')[0].replace('UNDP Albania Supreme Court Roadmap-63929373-b7ed-4b68-88a4-b2a151b43979.csv','UNDP Albania Supreme Court Roadmap-a12bc874-0600-4aca-9c00-be749cf12f24.csv'))
import re
W=1812; left=133; scale=25; day0=datetime.date(2026,10,18)
def x(d): return left+(d-day0).days*scale
palette={'Plan':'#334155','Checkpoints':'#334155','DevOps':'#125b50','Dashboard':'#1b6625','Anonymization':'#183eab','Drafting agent':'#78117b','Research agent':'#926a0c','Milestones':'#bd1e1e'}
def label(t):
    s=t['title'].replace(' (final)','').replace(' (1)','').replace(' (2)','')
    if t['notes']: s+=' - '+t['notes'].lower()
    return s.replace('—','-').replace('·','-')
for sec in sections:
    if sec['name'] in ('Plan','Checkpoints','Milestones'): continue
    ends=[]
    for t in sorted([t for t in sec['tasks'] if t['status']!='Done'],key=lambda t:(t['start'],t['end'])):
        start=x(t['start']); stop=x(t['end'])+25+len(label(t))*3.65+10
        lane=next((i for i,e in enumerate(ends) if e+8<start),len(ends))
        if lane==len(ends): ends.append(stop)
        else: ends[lane]=stop
        t['lane']=lane
    for t in sec['tasks']:
        if t['status']=='Done': t['lane']=len(ends)
    sec['height']=(len(ends)+(any(t['status']=='Done' for t in sec['tasks'])))*23+10
sections[0]['height']=56; sections[1]['height']=29; sections[-1]['height']=57
H=62+sum(s['height'] for s in sections)+42
svg=[]
def rect(x,y,w,h,fill,stroke='none',dash='',rx=2,opacity=1): svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" fill-opacity="{opacity}" stroke="{stroke}" stroke-width="1.4" stroke-dasharray="{dash}" rx="{rx}"/>')
def text(x,y,s,size=8.4,color='#24314a',bold=False,anchor='start'):
    svg.append(f'<text x="{x}" y="{y}" font-family="Arial" font-size="{size}" fill="{color}" font-weight="{700 if bold else 400}" text-anchor="{anchor}">{html.escape(s)}</text>')
def diamond(cx,cy,color): svg.append(f'<path d="M {cx} {cy-10} l 10 10 l -10 10 l -10 -10 z" fill="{color}" stroke="#24314a" stroke-width="0.8"/>')
rect(0,0,W,H,'white')
text(W/2,23,'Roadmap - report date 29 Oct 2026 (red line) | Six weeks to 10 Dec | solid = done, outlined = to do, dotted = needs input',14,bold=True,anchor='middle')
y=62
for i,sec in enumerate(sections):
    name=sec['name']; color=palette[name]; h=sec['height']
    if i%2==0: rect(5,y,W-10,h,'#f1f5f9',rx=0)
    for day in range(63):
        if (day0+datetime.timedelta(days=day)).weekday() in (4,5): rect(left+day*scale,y,scale,h,'#64748b',rx=0,opacity=.045)
    text(13,y+17,name,10,color,True)
    if name=='Plan':
        for t in sec['tasks']:
            xx=x(t['start']); ww=(t['end']-t['start']).days*scale+25
            rect(xx,y+1,ww,22,color,color)
            text(xx+ww/2,y+15,t['title'],8.5,'white',True,'middle')
        for w in range(6):
            d=datetime.date(2026,11,1)+datetime.timedelta(days=7*w); xx=x(d)
            rect(xx,y+29,125,20,'white','#91a4bc','2,2')
            text(xx+62.5,y+42,f'W{w+1} - {d.day}-{(d+datetime.timedelta(days=4)).day} {d.strftime("%b")}',8,anchor='middle')
    elif name=='Checkpoints':
        for t in sec['tasks']:
            xx=x(t['start'])+12.5; diamond(xx,y+14,color); text(xx+14,y+17,t['title'],8.5,color,True)
    elif name=='Milestones':
        for t in sec['tasks']:
            if t['title'].startswith('M'):
                xx=x(t['start'])+12.5; diamond(xx,y+14,color); text(xx+14,y+18,t['title'],8,color,True)
            else:
                xx=x(t['start']); ww=(t['end']-t['start']).days*scale+25
                rect(xx,y+32,ww,21,'#fff5f5',color); text(xx+ww/2,y+46,t['title'],8,color,True,'middle')
    else:
        for t in sec['tasks']:
            yy=y+11+t['lane']*23; xx=x(t['start']); ww=(t['end']-t['start']).days*scale+25
            rect(xx,yy,ww,18,color,color,'2,2' if t['status']=='Needs input' else '',opacity=1 if t['status']=='Done' else .08)
            text(xx+ww+5,yy+12,label(t),8.2,color)
    y+=h
for d in range(0,64,7):
    xx=left+d*scale
    svg.append(f'<line x1="{xx}" y1="48" x2="{xx}" y2="{y+10}" stroke="#8491a3" stroke-width=".6"/>')
    text(xx+3,46,(day0+datetime.timedelta(days=d)).strftime('%d %b'),8,color='#5c6470')
    text(xx+3,y+24,(day0+datetime.timedelta(days=d)).strftime('%d %b'),8,color='#5c6470')
xx=x(datetime.date(2026,10,29)); svg.append(f'<line x1="{xx}" y1="30" x2="{xx}" y2="{H-5}" stroke="#cf3030" stroke-width="3"/>')
markup=f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'+''.join(svg)+'</svg>'
out.write_text(f'<html><head><meta charset="utf-8"><style>@page{{size:{W}pt {H}pt;margin:0}}body{{margin:0}}svg{{width:{W}pt;height:{H}pt;display:block}}</style></head><body>{markup}</body></html>',encoding='utf-8')
print('Tasks:',sum(len(s['tasks']) for s in sections),'Size:',W,H)
