import { useEffect, useRef } from 'react';
import { Chart, LineController, LineElement, PointElement, CategoryScale, LinearScale, PieController, ArcElement, Tooltip } from 'chart.js';

Chart.register(LineController,LineElement,PointElement,CategoryScale,LinearScale,PieController,ArcElement,Tooltip);

export function SalesChart({ labels, values, title, type, currency }: {
  labels: string[]; values: number[]; title: string; type: 'line'|'pie'; currency: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const formatter = new Intl.NumberFormat(undefined,{style:'currency',currency});
    const chart = new Chart(canvas.current,{
      type, data:{labels,datasets:[{label:title,data:values,borderColor:'#185847',
        backgroundColor:type === 'pie' ? ['#185847','#e2a544'] : '#185847',pointRadius:values.length > 32 ? 0 : 3}]},
      options:{responsive:true,maintainAspectRatio:false,animation:false,
        plugins:{tooltip:{callbacks:{label:context => formatter.format(Number(context.raw))}}},
        ...(type === 'line' && {scales:{y:{beginAtZero:true},x:{ticks:{maxTicksLimit:8}}}})}
    });
    return () => chart.destroy();
  },[labels,values,title,type,currency]);
  return <div className="sales-chart"><canvas ref={canvas} role="img" aria-label={title}/></div>;
}
