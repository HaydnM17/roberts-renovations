(function(){
var s=document.currentScript,d=document,h=d.documentElement;
if(!s)return;
var k='mockup-bar:'+new URL('./',s.src).pathname;
try{if(localStorage.getItem(k)==='1')return}catch(e){}
function el(t,c,x){var e=d.createElement(t);if(c)e.className=c;if(x)e.textContent=x;return e}
function add(p,t,u){var a=el('a','',t);a.href=u;p.appendChild(a)}
function go(){
var b=el('div','mb'),t=el('p','mb-t'),l=el('p','mb-l'),x=el('button','','\u00d7');
b.setAttribute('role','note');
t.appendChild(el('b','','Sample site made by Haydn McIntyre for '+(s.getAttribute('data-business')||'this business')+'.'));
t.appendChild(d.createTextNode(' '));
t.appendChild(el('span','','Anything can be changed, or I can make a different design.'));
add(l,'haydnmcintyre.ca','https://'+'haydnmcintyre.ca');
add(l,'(905) 347-0377','tel:+19053470377');
x.type='button';x.setAttribute('aria-label','Hide this note');
function size(){h.style.setProperty('--mb-h',b.offsetHeight+'px')}
x.onclick=function(){
try{localStorage.setItem(k,'1')}catch(e){}
b.remove();h.classList.remove('mb-on');h.style.removeProperty('--mb-h');
removeEventListener('resize',size)};
b.append(t,l,x);d.body.appendChild(b);
h.classList.add('mb-on');size();
addEventListener('resize',size);
if(window.ResizeObserver)new ResizeObserver(size).observe(b);
}
d.body?go():addEventListener('DOMContentLoaded',go);
})();
