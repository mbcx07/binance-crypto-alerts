/**
 * generar-informe-word.js
 * Genera el informe Word de Análisis de Tiempo Extra y Ausentismo
 * basado en el Excel de la 1ra quincena de marzo 2026.
 */

const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('/tmp/node_modules/docx/dist/index.umd.cjs');
const xlsx = require('/tmp/node_modules/xlsx');
const fs = require('fs');

// ── DATOS DEL EXCEL ──────────────────────────────────────────
const EXCEL = '/home/moises-beltran-castro/.openclaw/media/inbound/AUSENTISMO_Y_TIEMPO_EXTRA_PERSONAL_ESTRATEGIA_1RA_DE_MAR_202---46282ef5-f401-4ff6-bafd-9782a230f510.xlsx';

const wb = xlsx.readFile(EXCEL);
const ws = wb.Sheets['TODOS'];
const raw = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });

const units = {};
raw.slice(3).forEach(row => {
  if (!row[0] || row[0] === '') return;
  const u = row[0];
  if (!units[u]) units[u] = { TE: 0, LSSmayor: 0, LSSmenor: 0, LCS: 0, FI: 0, IEG: 0, IRT: 0, MAT: 0, VAC: 0, BECA: 0, COM: 0, COMCAP: 0, CLAUS42: 0 };
  units[u].TE += parseFloat(row[6] || 0);
  units[u].LSSmayor += parseInt(row[7] || 0);
  units[u].LSSmenor += parseInt(row[8] || 0);
  units[u].LCS += parseInt(row[9] || 0);
  units[u].FI += parseInt(row[10] || 0);
  units[u].IEG += parseInt(row[11] || 0);
  units[u].IRT += parseInt(row[12] || 0);
  units[u].MAT += parseInt(row[13] || 0);
  units[u].VAC += parseInt(row[14] || 0);
  units[u].BECA += parseInt(row[15] || 0);
  units[u].COM += parseInt(row[16] || 0);
  units[u].COMCAP += parseInt(row[17] || 0);
  units[u].CLAUS42 += parseInt(row[18] || 0);
});

// ── HELPERS ───────────────────────────────────────────────────
const bold = (text) => new TextRun({ text, bold: true, size: 22 });
const space = () => new Paragraph({ children: [new TextRun({ text: '' })] });
const centered = (runs) => new Paragraph({ children: runs, alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 } });
const heading = (text) => new Paragraph({
  children: [new TextRun({ text, bold: true, size: 24 })],
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 200, after: 100 },
});
const body = (text) => new Paragraph({
  children: [new TextRun({ text, size: 22 })],
  spacing: { before: 60, after: 60 },
  alignment: AlignmentType.JUSTIFIED,
});

const unitNames = {
  '03HD01': 'Hospital 1',
  '03HE38': 'Hospital 38',
  '03HF02': 'Hospital 2',
  '03HF05': 'Hospital 5',
  '03HF26': 'Hospital 26',
  '03UA34': 'UMF 34',
  '03UF19': 'UMF 19',
};

function unitParagraph(key, d) {
  const name = unitNames[key] || key;
  const te = d.TE.toFixed(2);
  const parts = [];
  const add = (label, val) => { if (val > 0) parts.push(`${val} días de ${label}`); };

  add('falta injustificada', d.FI);
  add('incapacidad por enfermedad general', d.IEG);
  add('incapacidad por riesgo de trabajo', d.IRT);
  add('incapacidad por maternidad', d.MAT);
  add('vacaciones', d.VAC);
  add('licencia sin sueldo mayor a 3 días', d.LSSmayor);
  add('licencia sin sueldo menor a 4 días', d.LSSmenor);
  add('licencia con sueldo', d.LCS);
  add('beca con sueldo', d.BECA);
  add('comisión', d.COM);
  add('comisión para capacitación', d.COMCAP);
  add('comisión Claus 42 incisos H, I, J CCT', d.CLAUS42);

  const body_text = parts.length > 0
    ? `En ${name} (${key}) se registraron ${te} horas de tiempo extraordinario. Durante el periodo se acumularon ${parts.join(', ')}.`
    : `${name} (${key}) no registró horas de tiempo extraordinario ni días de ausentismo durante la quincena, manteniéndose estable en su operación.`;

  return new Paragraph({
    children: [new TextRun({ text: body_text, size: 22 })],
    spacing: { before: 60, after: 60 },
    alignment: AlignmentType.JUSTIFIED,
  });
}

// ── DOCUMENTO ─────────────────────────────────────────────────
const children = [
  centered([bold('ÓRGANO DE OPERACIÓN ADMINISTRATIVA')]),
  centered([bold('DESCONCENTRADA REGIONAL EN B.C.S.')]),
  space(),
  centered([bold('JEFATURA DE SERVICIOS DE DESARROLLO DE PERSONAL')]),
  space(), space(),

  centered([bold('Análisis comparativo tiempo extraordinario y ausentismo del personal en plazas de')]),
  centered([bold('Estrategia 02-30-100 periodo del 1 al 15 de Marzo 2026')]),
  space(),

  body('Durante la primera quincena de marzo de 2026 se observa un incremento generalizado en el uso del tiempo extraordinario en la mayoría de las unidades hospitalarias. Los principales factores que impulsan este aumento son el alto volumen de días de incapacidad por enfermedad general, los días de vacaciones y las faltas injustificadas, los cuales impactan directamente en la disponibilidad de personal para la cobertura de los servicios. A continuación se presenta el análisis por unidad operativa.'),
  space(),

  heading('Hospital 1 (03HD01)'),
  unitParagraph('03HD01', units['03HD01'] || {}),
  body('El volumen elevado de vacaciones (108 días) y las incapacidades médicas (18 días por enfermedad general, 6 por riesgo de trabajo, 14 por maternidad) generan una presión significativa sobre la plantilla disponible. Las 11 faltas injustificadas también contribuyen al déficit de personal, lo que explica el uso intensivo del tiempo extraordinario para mantener la operación.'),

  heading('Hospital 38 (03HE38)'),
  unitParagraph('03HE38', units['03HE38'] || {}),
  body('Aunque el número de incapacidades médicas es menor comparado con otras unidades, el volumen de vacaciones (49 días) y las 8 comisiones Claus 42 incisos H, I, J del CCT generan una carga operativa importante. Las 6 faltas injustificadas y la licencia sin sueldo menor a 4 días agravan la situación, provocando un incremento notable en las horas de tiempo extraordinario.'),

  heading('Hospital 2 (03HF02)'),
  unitParagraph('03HF02', units['03HF02'] || {}),
  body('La principal causa del tiempo extraordinario en esta unidad es la alta incidencia de incapacidades por enfermedad general (15 días), sumada a 8 días de vacaciones y 1 día de licencia con sueldo. Aunque no se registran faltas injustificadas, la concentración de ausentismo médico obliga a cubrir turnos con personal adicional mediante tiempo extraordinario.'),

  heading('Hospital 5 (03HF05)'),
  unitParagraph('03HF05', units['03HF05'] || {}),
  body('Esta unidad presenta los valores más bajos de ausentismo y tiempo extraordinario de la región. Se registran solo 2 días de vacaciones, 1 falta injustificada y 4 comisiones. El uso moderado del tiempo extraordinario (11.82 horas) refleja una operación relativamente estable, aunque se mantiene el factor estructural de vacantes médicas no cubiertas.'),

  heading('Hospital 26 (03HF26)'),
  unitParagraph('03HF26', units['03HF26'] || {}),
  body('Este hospital registra una de las cargas más elevadas con 91.99 horas de tiempo extraordinario. Destaca de manera importante el acumulado de 59 días de licencia sin sueldo mayor a 3 días, lo que representa una ausencia prolongada de personal que requiere sustitución. Adicionalmente, se registran 9 días de incapacidad por maternidad, 49 días de vacaciones y 3 días de licencia con sueldo, configurando un escenario de alta demanda sobre la plantilla activa.'),

  heading('UMF 34 (03UA34)'),
  unitParagraph('03UA34', units['03UA34'] || {}),
  body('La UMF 34 presenta una presión operativa considerable derivada de 21 días de vacaciones, 11 días de incapacidad por enfermedad general y 6 días de licencia con sueldo. Aunque el ausentismo disciplinario es moderado (3 faltas injustificadas), la combinación de ausencia programada y no programada genera la necesidad de recurrir al tiempo extraordinario para garantizar la atención de los servicios.'),

  heading('UMF 19 (03UF19)'),
  unitParagraph('03UF19', units['03UF19'] || {}),
  body('La UMF 19 no registró horas de tiempo extraordinario ni días de ausentismo de consideración durante la quincena. No se detectaron incapacidades médicas, vacaciones ni licencias disciplinarias, manteniéndose estable en su operación.'),

  space(),
  heading('Conclusión general'),
  body('En términos generales, la primera quincena de marzo de 2026 confirma que los principales factores que impulsan el uso del tiempo extraordinario son el alto volumen de vacaciones, las incapacidades por enfermedad general y las faltas injustificadas. El Hospital 38 y el Hospital 1 registran los mayores consumos de tiempo extraordinario, mientras que el Hospital 26 destaca por la acumulación excepcional de licencias sin sueldo mayores a 3 días, lo que representa un factor de riesgo operativo que requiere atención prioritaria. La UMF 19 se mantiene como la unidad más estable de la región. Se recomienda fortalecer la planeación de suplencias, dar seguimiento puntual a las incapacidades recurrentes y mantener control sobre el ausentismo disciplinario para reducir la dependencia del tiempo extraordinario y equilibrar la carga laboral del personal activo.'),
  space(), space(),
  centered([bold('MTRA. ARIADNA FABIOLA FERNANDEZ MEZA')]),
  centered([bold('JEFATURA DE SERVICIOS DE DESARROLLO DE PERSONAL')]),
];

const doc = new Document({ sections: [{ children }] });
Packer.toBuffer(doc).then(buf => {
  const out = '/home/moises-beltran-castro/.openclaw/workspace/AUSENTISMO_Y_TIEMPO_EXTRA_1RA_MAR_2026.docx';
  fs.writeFileSync(out, buf);
  console.log('✅ Word generado:', out);
}).catch(e => console.error(e));
