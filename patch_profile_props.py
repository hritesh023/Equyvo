p='src/pages/ProfilePage.tsx'
s=open(p,encoding='utf-8').read()
s=s.replace("          onComment={(videoId, creator) => handleComment(videoId, creator)}\n","")
s=s.replace("          onShare={(v) => handleShare(v as any)}\n","")
open(p,'w',encoding='utf-8').write(s)
print('done')
