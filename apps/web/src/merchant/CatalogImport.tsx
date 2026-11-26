import { useEffect, useState } from 'react';
import { Action, request } from '../onboarding';

type Draft = {
  digest: string;
  rows: Array<{ sku: string; photo?: string | null; category?: string | null; hsn?:string|null; product: string; barcode: string; priceMinor: number; openingStock: number | null }>;
  issues: Array<{ row: number; message: string }>;
};

async function productPhoto(form: FormData) {
  const file = form.get('photo');
  const remove = form.has('removePhoto');
  if (!(file instanceof File) || !file.size) return remove ? null : undefined;
  if (remove) throw new Error('Choose either a replacement photo or removal');
  if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 5_000_000)
    throw new Error('Choose a PNG, JPEG or WebP image up to 5 MB');
  const image = await createImageBitmap(file).catch(() => { throw new Error('Could not read this photo'); });
  try {
    const scale = Math.min(1, 128 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not resize this photo');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally { image.close(); }
}

export function CatalogImport({ path, token }: { path: string; token: string }) {
  const [items, setItems] = useState<Draft['rows']>([]);
  const [sort, setSort] = useState<'sku'|'product'|'priceMinor'>('sku');
  const [filter, setFilter] = useState('');
  const [search,setSearch] = useState('');
  const [revision,refresh] = useState(0);
  const [loading,setLoading] = useState(true);
  const [failure,setFailure] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setFailure('');
    void request<Draft['rows']>(`${path}/items?${filter}`,token)
      .then(rows => { if (active) setItems(rows); })
      .catch(error => { if (active) { setItems([]); setFailure(String(error.message)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active=false; };
  },[path,token,filter,revision]);
  const term = search.trim().toLowerCase();
  const visible = items.filter(item => [item.product,item.sku,item.barcode].some(value => value.toLowerCase().includes(term)));
  const [preview, setPreview] = useState<{ csv: string; draft: Draft }>();
  return <><label>Search catalog<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Product, SKU or barcode" /></label>
    <Action title="Apply attribute filter" run={async form => {
    const key = String(form.get('attribute')).trim();
    const value = String(form.get('value')).trim();
    if (!!key !== !!value) throw new Error('Enter both an attribute and a value');
    const query = key ? new URLSearchParams([[key,value]]).toString() : '';
    setFilter(query); refresh(n=>n+1); return '';
  }}><label>Attribute<input name="attribute" placeholder="size" /></label>
    <label>Value<input name="value" placeholder="M" /></label></Action>
    <label>Sort items<select value={sort} onChange={e => setSort(e.target.value as typeof sort)}>
      <option value="sku">SKU</option><option value="product">Product</option><option value="priceMinor">Price</option>
    </select></label>
    {failure && <p role="alert">{failure}</p>}
    {loading ? <p role="status">Loading catalog…</p> : !failure && !visible.length && <p>No matching catalog items.</p>}
    <table><thead><tr><th>SKU</th><th>Barcode</th><th>Product and price</th></tr></thead>
      <tbody>{visible.sort((a,b) => sort === 'priceMinor' ? a.priceMinor-b.priceMinor : a[sort].localeCompare(b[sort])).map(item =>
        <tr key={item.sku}><td>{item.sku}</td><td>{item.barcode}</td><td><Action key={JSON.stringify(item)} title="Save item" run={async form => {
          await request(`${path}/items`, token, { sku: item.sku, photo: await productPhoto(form), category: form.get('category'), hsn:form.get('hsn'), product: form.get('product'), priceMinor: Number(form.get('price')) });
          refresh(n=>n+1); return 'Saved';
        }}><label>Product<input name="product" required maxLength={150} defaultValue={item.product} /></label>
          {item.photo && <><img src={item.photo} alt={item.product} loading="lazy" height="64" /><label><input name="removePhoto" type="checkbox" />Remove photo</label></>}
          <label>Product photo<input name="photo" type="file" accept="image/png,image/jpeg,image/webp" /></label>
          <label>HSN<input name="hsn" inputMode="numeric" pattern="(?:[0-9]{4}|[0-9]{6}|[0-9]{8})" defaultValue={item.hsn ?? ''}/></label>
          <label>Category<input name="category" maxLength={80} defaultValue={item.category ?? ''} /></label>
          <label>Price (minor units)<input name="price" required type="number" min="0" max="1000000000" defaultValue={item.priceMinor} /></label>
        </Action></td></tr>)}</tbody></table><details>
    <summary>Import catalog and opening stock</summary>
    <p>Add an optional final category column to group products at checkout. Prices use minor units. Leave opening stock blank to preserve previously recorded stock.</p>
    <Action title="Preview CSV" run={async (form) => {
      setPreview(undefined);
      const file = form.get('csv');
      if (!(file instanceof File) || !file.size || file.size > 100_000) throw new Error('Choose a CSV file up to 100 KB');
      const csv = await file.text();
      const draft = await request<Draft>(`${path}/preview`, token, { csv });
      setPreview({ csv, draft });
      return draft.issues.length ? 'Fix the listed issues and preview again.' : `${draft.rows.length} rows ready to confirm.`;
    }}>
      <label>Catalog CSV<input name="csv" type="file" accept=".csv,text/csv" required onChange={() => setPreview(undefined)} /></label>
    </Action>
    {preview && (preview.draft.issues.length ? <ul>
      {preview.draft.issues.map(({ row, message }, index) => <li key={index}>Row {row} · {message}</li>)}
    </ul> : <>
      <table><thead><tr><th>SKU</th><th>Product</th><th>Barcode</th><th>Price (minor units)</th><th>Opening stock</th><th>Category</th></tr></thead>
        <tbody>{preview.draft.rows.map((row) => <tr key={row.sku}>
          <td>{row.sku}</td><td>{row.product}</td><td>{row.barcode}</td><td>{row.priceMinor}</td><td>{row.openingStock ?? 'Unchanged'}</td><td>{row.category ?? 'Unchanged'}</td>
        </tr>)}</tbody>
      </table>
      <Action key={preview.draft.digest} title="Confirm and publish" run={async () => {
        const result = await request<{ version: string; replayed: boolean }>(`${path}/confirm`, token,
          { csv: preview.csv, digest: preview.draft.digest });
        refresh(n=>n+1);
        return result.replayed ? `Already imported as version ${result.version}.` : `Version ${result.version} is available to paired counters.`;
      }} />
    </>)}
  </details></>;
}
