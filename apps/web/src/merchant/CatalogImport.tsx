import { useState } from 'react';
import { Action, request } from '../onboarding';

type Draft = {
  digest: string;
  rows: Array<{ sku: string; product: string; barcode: string; priceMinor: number; openingStock: number | null }>;
  issues: Array<{ row: number; message: string }>;
};

export function CatalogImport({ path, token }: { path: string; token: string }) {
  const [items, setItems] = useState<Draft['rows']>([]);
  const [sort, setSort] = useState<'sku'|'product'|'priceMinor'>('sku');
  async function load() { setItems(await request<Draft['rows']>(`${path}/items`, token)); }
  const [preview, setPreview] = useState<{ csv: string; draft: Draft }>();
  return <><Action title="Load catalog items" run={async () => { await load(); return ''; }} />
    <label>Sort items<select value={sort} onChange={e => setSort(e.target.value as typeof sort)}>
      <option value="sku">SKU</option><option value="product">Product</option><option value="priceMinor">Price</option>
    </select></label>
    <table><thead><tr><th>SKU</th><th>Barcode</th><th>Product and price</th></tr></thead>
      <tbody>{[...items].sort((a,b) => sort === 'priceMinor' ? a.priceMinor-b.priceMinor : a[sort].localeCompare(b[sort])).map(item =>
        <tr key={item.sku}><td>{item.sku}</td><td>{item.barcode}</td><td><Action key={JSON.stringify(item)} title="Save item" run={async form => {
          await request(`${path}/items`, token, { sku: item.sku, product: form.get('product'), priceMinor: Number(form.get('price')) });
          await load(); return 'Saved';
        }}><label>Product<input name="product" required maxLength={150} defaultValue={item.product} /></label>
          <label>Price (minor units)<input name="price" required type="number" min="0" max="1000000000" defaultValue={item.priceMinor} /></label>
        </Action></td></tr>)}</tbody></table><details>
    <summary>Import catalog and opening stock</summary>
    <p>Prices use minor units. Leave opening stock blank to preserve previously recorded stock.</p>
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
      <table><thead><tr><th>SKU</th><th>Product</th><th>Barcode</th><th>Price (minor units)</th><th>Opening stock</th></tr></thead>
        <tbody>{preview.draft.rows.map((row) => <tr key={row.sku}>
          <td>{row.sku}</td><td>{row.product}</td><td>{row.barcode}</td><td>{row.priceMinor}</td><td>{row.openingStock ?? 'Unchanged'}</td>
        </tr>)}</tbody>
      </table>
      <Action key={preview.draft.digest} title="Confirm and publish" run={async () => {
        const result = await request<{ version: string; replayed: boolean }>(`${path}/confirm`, token,
          { csv: preview.csv, digest: preview.draft.digest });
        return result.replayed ? `Already imported as version ${result.version}.` : `Version ${result.version} is available to paired counters.`;
      }} />
    </>)}
  </details></>;
}
