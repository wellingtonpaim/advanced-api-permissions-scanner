// Navegação
document.querySelectorAll('.tab').forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('section').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById(b.dataset.tab).classList.add('active');
  };
});

const svc = { files: [] };
const mdl = { files: [] };
const svcList = document.getElementById('list-services');
const mdlList = document.getElementById('list-models');
const bar = document.getElementById('bar');
const tbody = document.getElementById('tbody');

function addFiles(target, listEl, flist) {
  for (const f of flist) {
    if (!target.files.some(x=>x.name===f.name && x.size===f.size)) {
      target.files.push(f);
      const row = document.createElement('div');
      row.className='row';
      row.innerHTML = `<span>${f.name}</span><span class="rm">✖</span>`;
      row.querySelector('.rm').onclick=()=>{
        target.files = target.files.filter(z=>z!==f);
        row.remove();
      };
      listEl.appendChild(row);
    }
  }
}

function setupDrop(id, target, listEl) {
  const el = document.getElementById(id);
  el.ondragover = e=>{e.preventDefault(); el.classList.add('dragover');};
  el.ondragleave = ()=>el.classList.remove('dragover');
  el.ondrop = e=>{
    e.preventDefault(); el.classList.remove('dragover');
    addFiles(target, listEl, Array.from(e.dataTransfer.files));
  };
}

setupDrop('drop-services', svc, svcList);
setupDrop('drop-models', mdl, mdlList);

document.getElementById('inp-services').onchange = e => addFiles(svc, svcList, Array.from(e.target.files));
document.getElementById('inp-models').onchange = e => addFiles(mdl, mdlList, Array.from(e.target.files));

let lastResults = [];

document.getElementById('btn-analyze').onclick = async () => {
  if (!svc.files.length && !mdl.files.length) { alert('Adicione arquivos.'); return; }
  bar.style.width = '10%';
  const fd = new FormData();
  for (const f of svc.files) fd.append('services', f);
  for (const f of mdl.files) fd.append('models', f);
  fd.append('defaultDb', document.getElementById('defaultDb').value);
  fd.append('postgresConnName', document.getElementById('pgConn').value || '');
  bar.style.width = '40%';
  const resp = await fetch('http://localhost:3000/analyze', { method:'POST', body: fd });
  bar.style.width = '80%';
  const data = await resp.json();
  bar.style.width = '100%';
  setTimeout(()=>bar.style.width='0%', 600);
  lastResults = data.results || [];
  render();
};

document.getElementById('btn-reset').onclick = () => { lastResults = []; render(); };
document.getElementById('btn-csv').onclick = () => {
  if (!lastResults.length) return;
  const rows = filtered();
  let csv = 'Model,Tabela,Permissao,Banco,Origem\n';
  rows.forEach(r => { csv += `${r.model},${r.table},${r.permission},${r.banco},${r.origem}\n`; });
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href:url, download:'permissions.csv' });
  a.click(); URL.revokeObjectURL(url);
};

['f-banco','f-perm','f-text'].forEach(id => document.getElementById(id).oninput = render);

function filtered() {
  const banco = document.getElementById('f-banco').value;
  const perm = document.getElementById('f-perm').value;
  const text = (document.getElementById('f-text').value||'').toLowerCase();
  return lastResults.filter(r => {
    if (banco && r.banco !== banco) return false;
    if (perm && r.permission !== perm) return false;
    if (text && !(`${r.model} ${r.table}`.toLowerCase().includes(text))) return false;
    return true;
  });
}

function render() {
  const rows = filtered();
  tbody.innerHTML = '';
  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.model}</td><td>${r.table}</td><td>${r.permission}</td><td>${r.banco}</td><td>${r.origem}</td>`;
    tbody.appendChild(tr);
  });
}

