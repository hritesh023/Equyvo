p='src/pages/ProfilePage.tsx'
s=open(p,encoding='utf-8').read()
old="  onClose={closeFullscreen}\n          onContentChange={(content) => setFullscreenContent(content)}"
new="  onClose={closeFullscreen}\n          onExpand={() => {}}\n          onContentChange={(content) => setFullscreenContent(content)}"
assert old in s, 'nf'
s=s.replace(old,new,1)
open(p,'w',encoding='utf-8').write(s)
print('done')
