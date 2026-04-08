"use client";

import { useMemo, useState } from "react";
import { getSupabaseClient, hasSupabaseEnv, type Tables } from "@/lib/supabase";

type PairRecord = { personel: string; giris: Date; cikis: Date };
type DailyRow = {
  personel: string;
  tarih: string;
  brut: string;
  ogle_kesinti: string;
  net: string;
  beklenen: string;
  bakiye: string;
  durum: string;
};
type WeeklyRow = {
  personel: string;
  hafta: string;
  hafta_etiket: string;
  haftalik_net: string;
  haftalik_beklenen: string;
  haftalik_bakiye: string;
};

const DAILY_TARGET_MIN = 8 * 60 + 30;
const HALF_DAY_TARGET_MIN = DAILY_TARGET_MIN / 2;
const LUNCH_START_MIN = 11 * 60 + 30;
const LUNCH_END_MIN = 14 * 60 + 30;
const FULL_LUNCH_MIN = 60;
const WEEKEND_LUNCH_EXEMPT_THRESHOLD_MIN = 4 * 60 + 30;
const MAX_SHIFT_MIN = 18 * 60;
const FULL_HOLIDAYS = new Set(["01-01", "04-23", "05-01", "05-19", "07-15", "08-30", "10-29"]);
const HALF_HOLIDAYS = new Set(["10-28"]);

function normalizeText(value: unknown): string {
  if (value == null) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[çÇ]/g, "c")
    .replace(/[ğĞ]/g, "g")
    .replace(/[ıİ]/g, "i")
    .replace(/[öÖ]/g, "o")
    .replace(/[şŞ]/g, "s")
    .replace(/[üÜ]/g, "u");
}
function fmtDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtISODateTime(d: Date): string {
  return `${fmtDateKey(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function minutesToHHMM(total: number): string {
  const sign = total < 0 ? "-" : "";
  const abs = Math.abs(Math.round(total));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function hhmmToMinutes(text: string): number {
  if (!text) return 0;
  const sign = text.startsWith("-") ? -1 : 1;
  const raw = text.replace("-", "");
  const [h, m] = raw.split(":").map(Number);
  return sign * (((h || 0) * 60) + (m || 0));
}
function isWeekend(d: Date): boolean {
  return d.getDay() === 0 || d.getDay() === 6;
}
function isSunday(d: Date): boolean {
  return d.getDay() === 0;
}
function isSundayDateKey(isoDay: string): boolean {
  const d = new Date(`${isoDay}T00:00:00`);
  return d.getDay() === 0;
}
function mdKey(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function excelDateToJS(XLSX: any, value: unknown): Date | null | { timeOnly: true; h: number; m: number; s: number } {
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return new Date(parsed.y, parsed.m - 1, parsed.d, parsed.H || 0, parsed.M || 0, parsed.S || 0);
  }
  if (typeof value === "string") {
    const t = value.trim();
    let m = t.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
    m = t.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    m = t.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (m) return { timeOnly: true, h: +m[1], m: +m[2], s: +(m[3] || 0) };
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  return null;
}

function splitCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "\"") {
      if (inQuotes && next === "\"") {
        cell += "\"";
        i++;
      } else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

export default function PdksPage() {
  const [pdksFile, setPdksFile] = useState<File | null>(null);
  const [pairCount, setPairCount] = useState(0);
  const [personCount, setPersonCount] = useState(0);
  const [mazeretCount, setMazeretCount] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [cleanRecords, setCleanRecords] = useState<PairRecord[]>([]);
  const [dailyRows, setDailyRows] = useState<DailyRow[]>([]);
  const [weeklyRows, setWeeklyRows] = useState<WeeklyRow[]>([]);

  const [selectedPerson, setSelectedPerson] = useState("");

  const personOptions = useMemo(
    () => [...new Set(dailyRows.map((r) => r.personel))].sort((a, b) => a.localeCompare(b, "tr")),
    [dailyRows],
  );

  async function processAll() {
    setNotice("");
    setError("");
    try {
      if (!pdksFile) throw new Error("Ham PDKS dosyasi gerekli.");
      const XLSX = await import("xlsx");
      const buf = await pdksFile.arrayBuffer();
      const ext = (pdksFile.name.split(".").pop() || "").toLowerCase();

      let movements: Array<{ personel: string; datetime: Date; durum: "G" | "C" }> = [];

      const parseMovementRows = (rows: any[][]) => {
        let headerIdx = -1;
        let personel = -1;
        let tarih = -1;
        let saat = -1;
        let durum = -1;
        for (let i = 0; i < Math.min(rows.length, 20); i++) {
          rows[i].forEach((v, idx) => {
            const t = normalizeText(v);
            if (t.includes("personel adi soyadi")) personel = idx;
            else if (t === "tarih") tarih = idx;
            else if (t === "saat") saat = idx;
            else if (t === "durum") durum = idx;
          });
          if (personel >= 0 && tarih >= 0 && saat >= 0 && durum >= 0) {
            headerIdx = i;
            break;
          }
        }
        if (headerIdx === -1) throw new Error("Basliklar bulunamadi.");

        for (let i = headerIdx + 1; i < rows.length; i++) {
          const row = rows[i];
          const p = String(row[personel] ?? "").trim();
          const d = excelDateToJS(XLSX, row[tarih]);
          const t = excelDateToJS(XLSX, row[saat]);
          const rawDurum = normalizeText(row[durum]);
          const s: "G" | "C" | "" = rawDurum.startsWith("g")
            ? "G"
            : rawDurum.startsWith("c")
              ? "C"
              : "";
          if (!p || !d || !s) continue;
          let dt: Date | null = null;
          if (d instanceof Date && t && typeof t === "object" && "timeOnly" in t) {
            dt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.h, t.m, t.s || 0);
          } else if (d instanceof Date && t instanceof Date) {
            dt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.getHours(), t.getMinutes(), t.getSeconds());
          } else if (d instanceof Date) {
            dt = d;
          }
          if (!dt) continue;
          movements.push({ personel: p, datetime: dt, durum: s as "G" | "C" });
        }
      };

      if (ext === "csv") {
        const text = new TextDecoder("windows-1254").decode(buf);
        try {
          parseMovementRows(splitCsv(text, ";") as any[][]);
        } catch {
          parseMovementRows(splitCsv(text, ",") as any[][]);
        }
      } else {
        const wb = XLSX.read(buf, { type: "array", cellDates: true });
        wb.SheetNames.forEach((name) => {
          const ws = wb.Sheets[name];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }) as any[][];
          parseMovementRows(rows);
        });
      }

      // Pair G-C
      const byPerson = new Map<string, Array<{ datetime: Date; durum: "G" | "C" }>>();
      movements.forEach((m) => {
        if (!byPerson.has(m.personel)) byPerson.set(m.personel, []);
        byPerson.get(m.personel)!.push({ datetime: m.datetime, durum: m.durum });
      });
      const pairs: PairRecord[] = [];
      [...byPerson.entries()].forEach(([personel, list]) => {
        list.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
        let open: Date | null = null;
        list.forEach((x) => {
          if (x.durum === "G") {
            // Coklu giris durumunda en guncel girisi baz al.
            open = x.datetime;
            return;
          }
          if (!open) return;
          const diffMin = Math.round((x.datetime.getTime() - open.getTime()) / 60000);
          if (diffMin > 0 && diffMin <= MAX_SHIFT_MIN) {
            // Ayni gun + geceyi asan (24:00 sonrasi) vardiyalar burada eslesir.
            pairs.push({ personel, giris: open, cikis: x.datetime });
          }
          open = null;
        });
      });
      setCleanRecords(pairs);
      setPairCount(pairs.length);

      // Mazeret map from existing app data (Supabase izinler + personel)
      const mazeretMap = new Map<string, string>();
      if (hasSupabaseEnv) {
        const sb = getSupabaseClient();
        const [{ data: personeller }, { data: izinler }] = await Promise.all([
          sb.from("personel").select("id,ad"),
          sb.from("izinler").select("personel_id,izin_tipi,baslangic,bitis"),
        ]);
        const personelAdById = new Map((personeller ?? []).map((p) => [p.id, p.ad]));
        (izinler ?? []).forEach((i) => {
          const ad = personelAdById.get(i.personel_id);
          if (!ad) return;
          const from = new Date(i.baslangic + "T00:00:00");
          const to = new Date(i.bitis + "T00:00:00");
          for (let d = new Date(from); d.getTime() <= to.getTime(); d.setDate(d.getDate() + 1)) {
            mazeretMap.set(`${normalizeText(ad)}__${fmtDateKey(d)}`, i.izin_tipi);
          }
        });
      }
      setMazeretCount(mazeretMap.size);

      // Daily/weekly calculations
      const byP = new Map<string, PairRecord[]>();
      pairs.forEach((p) => {
        if (!byP.has(p.personel)) byP.set(p.personel, []);
        byP.get(p.personel)!.push(p);
      });
      const dRows: DailyRow[] = [];
      const wRows: WeeklyRow[] = [];
      [...byP.entries()].forEach(([personel, recs]) => {
        const byDay = new Map<string, PairRecord[]>();
        recs.forEach((r) => {
          const key = fmtDateKey(r.giris);
          if (!byDay.has(key)) byDay.set(key, []);
          byDay.get(key)!.push(r);
        });
        const weeks = new Map<string, { net: number; expected: number }>();
        [...byDay.keys()].sort().forEach((dayKey) => {
          const date = new Date(dayKey + "T00:00:00");
          const intervals = byDay.get(dayKey)!;
          const sorted = intervals.slice().sort((a, b) => a.giris.getTime() - b.giris.getTime());
          let gross = 0;
          sorted.forEach((x) => (gross += Math.round((x.cikis.getTime() - x.giris.getTime()) / 60000)));
          let outside = 0;
          for (let i = 0; i < sorted.length - 1; i++) {
            const prevEnd = minutesOfDay(sorted[i].cikis);
            const nextStart = minutesOfDay(sorted[i + 1].giris);
            const start = Math.max(prevEnd, LUNCH_START_MIN);
            const end = Math.min(nextStart, LUNCH_END_MIN);
            if (end > start) outside += end - start;
          }
          let lunch = Math.max(0, FULL_LUNCH_MIN - outside);
          // Cumartesi/Pazar icin farkli ogle kurali.
          if (isWeekend(date) && gross < WEEKEND_LUNCH_EXEMPT_THRESHOLD_MIN) lunch = 0;
          const net = Math.max(0, gross - lunch);

          let expected = 0;
          const md = mdKey(date);
          // Calisma gunleri: Pazartesi-Cumartesi. Pazar calisma beklenmez.
          if (!isSunday(date) && !FULL_HOLIDAYS.has(md)) {
            expected = HALF_HOLIDAYS.has(md) ? HALF_DAY_TARGET_MIN : DAILY_TARGET_MIN;
            const mazeret = normalizeText(mazeretMap.get(`${normalizeText(personel)}__${dayKey}`) || "");
            if (["izin", "rapor", "tatil", "dis", "dış"].includes(mazeret)) expected = 0;
          }

          const ws = new Date(date);
          const day = ws.getDay();
          const diff = day === 0 ? -6 : 1 - day;
          ws.setDate(ws.getDate() + diff);
          const we = new Date(ws);
          we.setDate(we.getDate() + 6);
          const haftaKey = fmtDateKey(ws);
          const haftaEtiket = `${fmtDateKey(ws)} / ${fmtDateKey(we)}`;
          if (!weeks.has(haftaKey)) weeks.set(haftaKey, { net: 0, expected: 0 });
          weeks.get(haftaKey)!.net += net;
          weeks.get(haftaKey)!.expected += expected;

          dRows.push({
            personel,
            tarih: dayKey,
            brut: minutesToHHMM(gross),
            ogle_kesinti: minutesToHHMM(lunch),
            net: minutesToHHMM(net),
            beklenen: minutesToHHMM(expected),
            bakiye: minutesToHHMM(net - expected),
            durum: mazeretMap.get(`${normalizeText(personel)}__${dayKey}`) || "",
          });
          if (!wRows.find((w) => w.personel === personel && w.hafta === haftaKey)) {
            wRows.push({
              personel,
              hafta: haftaKey,
              hafta_etiket: haftaEtiket,
              haftalik_net: "00:00",
              haftalik_beklenen: "00:00",
              haftalik_bakiye: "00:00",
            });
          }
        });

        wRows.forEach((w) => {
          if (w.personel !== personel) return;
          const agg = weeks.get(w.hafta);
          if (!agg) return;
          w.haftalik_net = minutesToHHMM(agg.net);
          w.haftalik_beklenen = minutesToHHMM(agg.expected);
          w.haftalik_bakiye = minutesToHHMM(agg.net - agg.expected);
        });
      });

      dRows.sort((a, b) => (a.personel === b.personel ? a.tarih.localeCompare(b.tarih) : a.personel.localeCompare(b.personel, "tr")));
      wRows.sort((a, b) => (a.personel === b.personel ? a.hafta.localeCompare(b.hafta) : a.personel.localeCompare(b.personel, "tr")));
      setDailyRows(dRows);
      setWeeklyRows(wRows);
      setPersonCount([...new Set(dRows.map((x) => x.personel))].length);
      setNotice("Hesap tamamlandi.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Islem sirasinda hata olustu.");
    }
  }

  const selectedDaily = useMemo(() => dailyRows.filter((r) => r.personel === selectedPerson), [dailyRows, selectedPerson]);
  const selectedWeekly = useMemo(() => weeklyRows.filter((r) => r.personel === selectedPerson), [weeklyRows, selectedPerson]);
  const selectedMonthly = useMemo(() => {
    const map = new Map<string, { net: number; expected: number }>();
    selectedDaily.forEach((r) => {
      const key = r.tarih.slice(0, 7);
      if (!map.has(key)) map.set(key, { net: 0, expected: 0 });
      map.get(key)!.net += hhmmToMinutes(r.net);
      map.get(key)!.expected += hhmmToMinutes(r.beklenen);
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [selectedDaily]);

  const previewCleanRecords = useMemo(() => {
    if (!selectedPerson) return cleanRecords.slice(0, 20);
    return cleanRecords.filter((r) => r.personel === selectedPerson).slice(0, 20);
  }, [cleanRecords, selectedPerson]);

  return (
    <div className="min-h-screen bg-slate-50 p-5 text-slate-900">
      <div className="mx-auto max-w-[1300px] space-y-5">
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h1 className="text-2xl font-bold">PDKS - Puantaj Raporu</h1>
          <p className="mt-2 text-sm text-slate-500">Mazeretler mevcut uygulamadaki Supabase kayitlarindan cekilir.</p>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div className="rounded-xl border border-slate-200 p-4">
              <b>Ham PDKS Dosyasi</b>
              <input className="mt-3 w-full" type="file" accept=".csv,.xls,.xlsx" onChange={(e) => setPdksFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="rounded-xl border border-slate-200 p-4">
              <b>Eslesen Cift</b>
              <div className="mt-2 text-3xl font-bold">{pairCount}</div>
            </div>
            <div className="rounded-xl border border-slate-200 p-4">
              <b>Personel / Mazeret</b>
              <div className="mt-2 text-xl font-bold">{personCount} / {mazeretCount}</div>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button className="rounded-xl bg-slate-900 px-4 py-2 text-white" onClick={() => void processAll()}>Hesapla</button>
          </div>
          {notice ? <div className="mt-3 rounded-lg bg-emerald-50 p-3 text-emerald-700">{notice}</div> : null}
          {error ? <div className="mt-3 rounded-lg bg-rose-50 p-3 text-rose-700">{error}</div> : null}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold">Secili Personel Kontrol Paneli</h2>
          <select className="mt-3 w-full rounded-xl border border-slate-300 p-2 md:w-[420px]" value={selectedPerson} onChange={(e) => setSelectedPerson(e.target.value)}>
            <option value="">Personel secin</option>
            {personOptions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-slate-200 p-3">
              <h3 className="mb-2 font-semibold">Gunluk</h3>
              <div className="max-h-80 overflow-auto text-xs">
                <table className="w-full border-collapse">
                  <thead><tr><th className="border-b p-1 text-left">Tarih</th><th className="border-b p-1 text-right">Net</th><th className="border-b p-1 text-right">Beklenen</th><th className="border-b p-1 text-right">Bakiye</th><th className="border-b p-1 text-left">Durum</th></tr></thead>
                  <tbody>
                    {selectedDaily.map((r) => (
                      <tr key={`${r.personel}-${r.tarih}`} className={isSundayDateKey(r.tarih) ? "bg-red-50" : ""}>
                        <td className="border-b p-1">{r.tarih}</td>
                        <td className="border-b p-1 text-right">{r.net}</td>
                        <td className="border-b p-1 text-right">{r.beklenen}</td>
                        <td className="border-b p-1 text-right">{r.bakiye}</td>
                        <td className="border-b p-1">{r.durum || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 p-3">
              <h3 className="mb-2 font-semibold">Haftalik</h3>
              <div className="max-h-80 overflow-auto text-xs">
                <table className="w-full border-collapse">
                  <thead><tr><th className="border-b p-1 text-left">Hafta</th><th className="border-b p-1 text-right">Net</th><th className="border-b p-1 text-right">Beklenen</th><th className="border-b p-1 text-right">Bakiye</th></tr></thead>
                  <tbody>
                    {selectedWeekly.map((r) => <tr key={`${r.personel}-${r.hafta}`}><td className="border-b p-1">{r.hafta_etiket}</td><td className="border-b p-1 text-right">{r.haftalik_net}</td><td className="border-b p-1 text-right">{r.haftalik_beklenen}</td><td className="border-b p-1 text-right">{r.haftalik_bakiye}</td></tr>)}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-slate-200 p-3">
            <h3 className="mb-2 font-semibold">Aylik Ozet</h3>
            <div className="max-h-64 overflow-auto text-xs">
              <table className="w-full border-collapse">
                <thead><tr><th className="border-b p-1 text-left">Ay</th><th className="border-b p-1 text-right">Net</th><th className="border-b p-1 text-right">Beklenen</th><th className="border-b p-1 text-right">Bakiye</th></tr></thead>
                <tbody>
                  {selectedMonthly.map(([ay, v]) => <tr key={ay}><td className="border-b p-1">{ay}</td><td className="border-b p-1 text-right">{minutesToHHMM(v.net)}</td><td className="border-b p-1 text-right">{minutesToHHMM(v.expected)}</td><td className="border-b p-1 text-right">{minutesToHHMM(v.net - v.expected)}</td></tr>)}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold">
            Ilk 20 Temiz Kayit{selectedPerson ? ` - ${selectedPerson}` : ""}
          </h2>
          <pre className="mt-2 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
{["personel,giris,cikis", ...previewCleanRecords.map((r) => `${r.personel},${fmtISODateTime(r.giris)},${fmtISODateTime(r.cikis)}`)].join("\n")}
          </pre>
        </section>
      </div>
    </div>
  );
}

