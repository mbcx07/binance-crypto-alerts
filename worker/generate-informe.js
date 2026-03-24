/**
 * generate-informe.js — Genera informe Word de análisis de tiempo extraordinario y ausentismo.
 *
 * Uso:
 *   node generate-informe.js <ruta_excel> <ruta_word_salida> [periodo]
 *
 * El Excel debe contener las hojas:
 *   - RESUMEN    → datos agregados por unidad (filas 4-9: unidad, TE horas, licencias, incapacidades, vacaciones...)
 *   - TODOS      → datos individuales por empleado
 *   - INCIDENCIAS→ catálogo de claves
 *
 * El Word de salida sigue el formato del documento "Análisis Tiempo Extra y Ausentismo Plazas Estrategia 2da de..."
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import xlsx from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

// ─── helpers ────────────────────────────────────────────────────────────────

function cell(ws, addr) {
  const v = ws[addr];
  return v ? v.v : null;
}
function col(ws, row, colIdx) {
  return cell(ws, xlsx.utils.encode_cell({ r: row, c: colIdx }));
}
function row(ws, rowIdx, startCol = 0, endCol = 20) {
  return Array.from({ length: endCol - startCol + 1 }, (_, i) =>
    col(ws, rowIdx, startCol + i)
  );
}
function sumRow(ws, rowIdx, startCol, endCol) {
  return row(ws, rowIdx, startCol, endCol)
    .reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
}
function num(v) { return typeof v === 'number' ? v : parseFloat(v) || 0; }
function fmt2(v) { return num(v).toFixed(2); }
function periodo(nombreUnidad, datos) {
  // Intenta extraer fechas del nombre del archivo o usa placeholder
  return datos.periodoTexto || 'enero 2026';
}

// ─── parse RESUMEN ──────────────────────────────────────────────────────────

function parseResumen(ws) {
  // Las filas de datos inician en fila 4 (0-indexed = 3)
  // Formato fila: [Unidad, TE_Horas, LicSS_M3d, LicSS_m4d, LicCS_Dias,
  //                 FaltaInj, IncapEnfGral, IncapRiesgo, IncapMat, Vacaciones,
  //                 BecaCSueldo, Comision, ComisionCap, ...]
  const unidades = [];
  for (let r = 3; r <= 10; r++) {
    const [clave, te, licSS_M3, licSS_m4, licCS, faltaInj,
           incapEg, incapRt, incapMat, vac, beca, comision, comCap] = row(ws, r, 0, 12);

    if (!clave || typeof clave !== 'string' || clave.trim() === '') break;
    if (clave.match(/ANALISIS|INDICADOR|UNIDAD|PLAZA/i)) continue;

    unidades.push({
      clave: clave.trim(),
      teHoras: num(te),
      licSS_M3d: num(licSS_M3),     // licencia sin sueldo mayor a 3 días
      licSS_m4d: num(licSS_m4),     // licencia sin sueldo menor a 4 días
      licCSdias: num(licCS),        // licencia con sueldo
      faltaInj: num(faltaInj),      // falta injustificada
      incapEg: num(incapEg),        // incapacidad enfermedad general
      incapRt: num(incapRt),        // incapacidad riesgo trabajo
      incapMat: num(incapMat),     // incapacidad maternidad
      vacaciones: num(vac),
      beca: num(beca),
      comision: num(comision),
      comisionCap: num(comCap),
    });
  }
  return unidades;
}

// ─── parse TODOS ────────────────────────────────────────────────────────────

function parseTodos(ws) {
  // Fila 1 = headers, datos desde fila 2
  // UNIDAD, PLAZA, MATRICULA, NOMBRE, CATEGORIA, AREA DE RESPONSABILIDAD,
  // 37-37A (TE horas), 39 (LicSS_M3d), 71 (LicSS_m4d), 64-65 (LicCS),
  // 72 (FaltaInj), 67-67A-67R (IncapEg), 69 (IncapRt), 68 (IncapMat),
  // 67-PAV (Vac), 87 (BecaCSueldo), 83 (Comision), 84 (ComisionCap), 90-90R
  const headers = row(ws, 1, 0, 20).map(h => String(h || '').trim());
  const empleados = [];
  for (let r = 2; ; r++) {
    const valores = row(ws, r, 0, 20);
    if (!valores[0]) break;
    empleados.push({
      unidad: valores[0],
      plaza: valores[1],
      matricula: valores[2],
      nombre: valores[3],
      categoria: valores[4],
      area: valores[5],
      teHoras: num(valores[6]),
      licSS_M3d: num(valores[7]),
      licSS_m4d: num(valores[8]),
      licCSdias: num(valores[9]),
      faltaInj: num(valores[10]),
      incapEg: num(valores[11]),
      incapRt: num(valores[12]),
      incapMat: num(valores[13]),
      vac: num(valores[14]),
      beca: num(valores[15]),
      comision: num(valores[16]),
      comisionCap: num(valores[17]),
    });
  }
  return empleados;
}

// ─── generar análisis por unidad ────────────────────────────────────────────

function analizarUnidad(u) {
  const partes = [];

  // Tiempo extraordinario
  if (u.teHoras > 0) {
    // ya se agrega en el Word
  } else {
    partes.push('No se registraron horas de tiempo extraordinario.');
    return partes.join(' ');
  }

  // Factores que justifican TE
  const factores = [];

  if (u.licSS_m4d > 0) factores.push(`${u.licSS_m4d} días de licencia sin sueldo menor a cuatro días`);
  if (u.licSS_M3d > 0) factores.push(`${u.licSS_M3d} días de licencia sin sueldo mayor a tres días`);
  if (u.licCSdias > 0) factores.push(`${u.licCSdias} días de licencia con sueldo`);
  if (u.faltaInj > 0) factores.push(`${u.faltaInj} días de falta injustificada`);
  if (u.incapEg > 0) factores.push(`${u.incapEg} días de incapacidad por enfermedad general`);
  if (u.incapRt > 0) factores.push(`${u.incapRt} días de incapacidad por riesgo de trabajo`);
  if (u.incapMat > 0) factores.push(`${u.incapMat} días de incapacidad por maternidad`);
  if (u.vacaciones > 0) factores.push(`${u.vacaciones} días de vacaciones`);
  if (u.beca > 0) factores.push(`${u.beca} días de beca con sueldo`);
  if (u.comision > 0) factores.push(`${u.comision} día(s) de comisión`);
  if (u.comisionCap > 0) factores.push(`${u.comisionCap} día(s) de comisión para capacitación`);

  if (factores.length > 0) {
    partes.push('Durante el periodo se acumularon ' + factores.join(', ') + '.');
  }

  // Ausentismo programado
  const prog = [];
  if (u.vacaciones > 0) prog.push(`${u.vacaciones} días de vacaciones`);
  if (u.beca > 0) prog.push(`${u.beca} día(s) de beca`);
  if (u.comision > 0) prog.push(`${u.comision} día(s) de comisión`);
  if (u.comisionCap > 0) prog.push(`${u.comisionCap} día(s) de comisión para capacitación`);
  if (prog.length > 0) {
    partes.push('En el ausentismo programado se contabilizaron ' + prog.join(', ') + '.');
  }

  // Causa principal (la de mayor impacto)
  const causales = [
    { clave: 'incapEg', valor: u.incapEg, texto: 'cobertura de días de incapacidad médica' },
    { clave: 'incapMat', valor: u.incapMat, texto: 'incapacidad por maternidad' },
    { clave: 'faltaInj', valor: u.faltaInj, texto: 'faltas injustificadas' },
    { clave: 'vacaciones', valor: u.vacaciones, texto: 'volumen de vacaciones' },
    { clave: 'licCSdias', valor: u.licCSdias, texto: 'licencias con sueldo' },
    { clave: 'licSS_m4d', valor: u.licSS_m4d, texto: 'licencias sin sueldo' },
  ].sort((a, b) => b.valor - a.valor);

  if (u.teHoras > 20 && causales[0].valor > 0) {
    partes.push(`La combinación de ${causales.filter(c => c.valor > 0).slice(0, 2).map(c =>
      (c.clave === 'incapEg' ? 'incapacidad médica' :
       c.clave === 'incapMat' ? 'maternidad' :
       c.clave === 'faltaInj' ? 'faltas injustificadas' :
       c.clave === 'vacaciones' ? 'vacaciones' :
       c.clave === 'licCSdias' ? 'licencias con sueldo' :
       'licencias sin sueldo')
    ).join(' y ')} explica el incremento importante en el uso del tiempo extraordinario.`);
  }

  return partes.join(' ');
}

// ─── generar párrafo general ───────────────────────────────────────────────

function generarAnalisisGeneral(unidades) {
  // Identificar unidades con mayor TE
  const conTE = unidades.filter(u => u.teHoras > 0).sort((a, b) => b.teHoras - a.teHoras);
  const sinTE = unidades.filter(u => u.teHoras === 0);

  const partes = [];

  if (conTE.length > 0) {
    const top3 = conTE.slice(0, 3);
    const nombresTop = top3.map(u => {
      const nombre = u.clave.replace('03HD', 'Hospital ').replace('03HE', 'Hospital ').replace('03HF', 'Hospital ').replace('03UA', 'UMF ').replace('03UF', 'UMF ');
      return `${nombre} (${fmt2(u.teHoras)} horas)`;
    });
    partes.push(`Las unidades con mayor consumo de tiempo extraordinario fueron ${nombresTop.join(', ')}.`);
  }

  // Factores comunes
  const sumIncAp = unidades.reduce((s, u) => s + u.incapEg + u.incapMat, 0);
  const sumVac = unidades.reduce((s, u) => s + u.vacaciones, 0);
  const sumFal = unidades.reduce((s, u) => s + u.faltaInj, 0);
  const sumLicCS = unidades.reduce((s, u) => s + u.licCSdias, 0);

  if (sumVac > 0 || sumIncAp > 0) {
    partes.push('El principal factor que impulsa el uso del tiempo extraordinario continúa siendo la acumulación de días de vacaciones y días de incapacidad médica.');
  }
  if (sumFal > 0) {
    partes.push('Las faltas injustificadas también impactan en la disponibilidad de personal.');
  }
  if (sumLicCS > 0) {
    partes.push('Las licencias con sueldo generan ausencias adicionales que incrementan la presión operativa.');
  }

  partes.push('Este comportamiento refuerza la necesidad de fortalecer la planeación de suplencias, dar seguimiento puntual a incapacidades recurrentes y mantener control sobre el ausentismo disciplinario para reducir la dependencia del tiempo extraordinario.');

  return partes.join(' ');
}

// ─── formatear nombre de unidad ─────────────────────────────────────────────

function nombreCompleto(clave) {
  if (!clave) return clave;
  return clave
    .replace(/^03HD/, 'Hospital ')
    .replace(/^03HE/, 'Hospital ')
    .replace(/^03HF/, 'Hospital ')
    .replace(/^03UA/, 'UMF ')
    .replace(/^03UF/, 'UMF ');
}

// ─── generar Word ────────────────────────────────────────────────────────────

async function generarWord(datos, periodoTexto, rutaSalida) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel,
          AlignmentType, BorderStyle } = await import('docx');

  const estilos = {
    titulo: { bold: true, size: 28, font: 'Calibri' },
    subtitulo: { bold: true, size: 24, font: 'Calibri' },
    parrafo: { size: 22, font: 'Calibri' },
    negrita: { bold: true, size: 22, font: 'Calibri' },
    firma: { bold: true, size: 22, font: 'Calibri', italics: true },
  };

  const children = [];

  // ── Titulo institucional ──
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'ÓRGANO DE OPERACIÓN ADMINISTRATIVA', ...estilos.titulo })],
    spacing: { after: 60 },
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'DESCONCENTRADA REGIONAL EN B.C.S.', ...estilos.titulo })],
    spacing: { after: 60 },
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'JEFATURA DE SERVICIOS DE DESARROLLO DE PERSONAL', ...estilos.subtitulo })],
    spacing: { after: 300 },
  }));

  // ── Titulo del informe ──
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({
      text: `Análisis comparativo tiempo extraordinario y ausentismo del personal en plazas de`,
      ...estilos.parrafo,
    })],
    spacing: { after: 120 },
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({
      text: `Estrategia 02-30-100 periodo del ${periodoTexto}`,
      bold: true,
      size: 24,
      font: 'Calibri',
    })],
    spacing: { after: 400 },
  }));

  // ── Párrafo introductorio ──
  children.push(new Paragraph({
    children: [new TextRun({
      text: `Durante ${periodoTexto} se observa un incremento en el uso del tiempo extraordinario en varias unidades hospitalarias, principalmente asociado a días de incapacidad por enfermedad general, días de maternidad, días de faltas injustificadas y un volumen importante de días de vacaciones que impactan directamente la disponibilidad de personal para la cobertura de los servicios.`,
      ...estilos.parrafo,
    })],
    spacing: { after: 240 },
  }));

  // ── Análisis por unidad ──
  for (const u of datos.unidades) {
    const nombre = nombreCompleto(u.clave);

    children.push(new Paragraph({
      children: [new TextRun({
        text: `En ${nombre} (${u.clave}) se registraron ${fmt2(u.teHoras)} horas de tiempo extraordinario.`,
        bold: true,
        ...estilos.parrafo,
      })],
      spacing: { after: 120 },
    }));

    const analisis = analizarUnidad(u);
    const oraciones = analisis.split('. ').filter(s => s.trim());

    for (const oracion of oraciones) {
      const texto = oracion.endsWith('.') ? oracion : oracion + '.';
      children.push(new Paragraph({
        children: [new TextRun({ text: texto, ...estilos.parrafo })],
        spacing: { after: 120 },
      }));
    }

    children.push(new Paragraph({ children: [], spacing: { after: 200 } }));
  }

  // ── Unidad sin TE ──
  const sinTE = datos.unidades.filter(u => u.teHoras === 0);
  if (sinTE.length > 0) {
    const nombresSin = sinTE.map(u => `${nombreCompleto(u.clave)} (${u.clave})`).join(', ');
    children.push(new Paragraph({
      children: [new TextRun({
        text: `Finalmente, ${nombresSin} no se registraron horas de tiempo extraordinario ni días de ausentismo durante la quincena, manteniéndose estabilidad operativa.`,
        ...estilos.parrafo,
      })],
      spacing: { after: 240 },
    }));
  }

  // ── Párrafo general ──
  children.push(new Paragraph({
    children: [new TextRun({
      text: generarAnalisisGeneral(datos.unidades),
      ...estilos.parrafo,
    })],
    spacing: { after: 400 },
  }));

  // ── Firma ──
  children.push(new Paragraph({ children: [], spacing: { after: 200 } }));
  children.push(new Paragraph({
    alignment: AlignmentType.LEFT,
    children: [new TextRun({
      text: 'MTRA ARIADNA FABIOLA FERNANDEZ MEZA',
      ...estilos.firma,
    })],
    spacing: { after: 60 },
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.LEFT,
    children: [new TextRun({
      text: 'JEFATURA DE SERVICIOS DE DESARROLLO DE PERSONAL',
      ...estilos.firma,
    })],
  }));

  const doc = new Document({
    sections: [{ children }],
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 22 },
        },
      },
    },
  });

  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(rutaSalida, buf);
  console.log(`Word generado: ${rutaSalida}`);
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Uso: node generate-informe.js <excel> <word_salida> [periodo]');
    process.exit(1);
  }

  const [rutaExcel, rutaWord, ...rest] = args;
  const periodoTexto = rest.join(' ') || 'enero 2026';

  if (!fs.existsSync(rutaExcel)) {
    console.error('Excel no encontrado:', rutaExcel);
    process.exit(1);
  }

  console.log(`Leyendo Excel: ${rutaExcel}`);
  const wb = xlsx.readFile(rutaExcel);

  const wsResumen = wb.Sheets['RESUMEN'];
  const wsTodos = wb.Sheets['TODOS'];

  if (!wsResumen) { console.error('Hoja RESUMEN no encontrada'); process.exit(1); }

  const unidades = parseResumen(wsResumen);
  console.log(`Unidades encontradas: ${unidades.length}`);
  unidades.forEach(u => console.log(` ${u.clave}: TE=${fmt2(u.teHoras)}h Vac=${u.vacaciones} IncapEg=${u.incapEg}`));

  const datos = { unidades, periodoTexto };

  await generarWord(datos, periodoTexto, rutaWord);
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
