import { useState } from 'react';
import { Action, request } from '../onboarding';

type Draft = {
  digest: string;
  rows: Array<{ sku: string; product: string; barcode: string; priceMinor: number; openingStock: number | null }>;
  issues: Array<{ row: number; message: string }>;
};

export function CatalogImport({ path, token }: { path: string; token: string }) {
  const [preview, setPreview] = useState<{ csv: string; draft: Draft }>();
  return <details>
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
  </details>;
}
