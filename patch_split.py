p='src/pages/ProfilePage.tsx'
s=open(p,encoding='utf-8').read()
old="""      // Set the new content immediately
      setFullscreenContent(content);
      
      // Clear temp content to avoid duplicate processing"""
new="""      // Set the new content immediately
      setFullscreenContent(content);
      const _ct = String(content?.type || content?.contentType || '').toLowerCase();
      // keep in sync with Discover's canonical fullscreen types
      // (no-op state here; FullscreenViewer normalizes, but keep parity)
      
      // Clear temp content to avoid duplicate processing"""
assert old in s, 'nf'
s=s.replace(old,new,1)
open(p,'w',encoding='utf-8').write(s)
print('done')
