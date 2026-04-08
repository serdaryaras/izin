"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  haftalik_fazla_mesai: string;
};
type UnmatchedRow = {
  personel: string;
  tarih_saat: string;
  durum: "G" | "C";
  neden: string;
};
type MovementRow = {
  id: string;
  source: "raw" | "manual";
  personel: string;
  datetime: Date;
  durum: "G" | "C";
};

const DAILY_TARGET_MIN = 8 * 60 + 30;
const HALF_DAY_TARGET_MIN = DAILY_TARGET_MIN / 2;
const LUNCH_START_MIN = 11 * 60;
const LUNCH_END_MIN = 14 * 60 + 30;
const FULL_LUNCH_MIN = 60;
const WEEKEND_LUNCH_ZERO_MAX_MIN = 4 * 60 + 15;
const WEEKEND_LUNCH_HALF_MAX_MIN = 8 * 60;
const MAX_SHIFT_MIN = 18 * 60;

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
function isSaturday(d: Date): boolean {
  return d.getDay() === 6;
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
function dedupeExactSameDirectionMovements(list: MovementRow[]): MovementRow[] {
  const seen = new Set<string>();
  const out: MovementRow[] = [];
  list.forEach((m) => {
    const key = `${normalizeText(m.personel)}__${fmtISODateTime(m.datetime)}__${m.durum}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  });
  return out;
}
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return fmtDateKey(d);
}
function holidayTypeFromRow(row: Record<string, unknown>): "full" | "half" {
  const raw = normalizeText(row.tur ?? row.tip ?? row.type ?? row.ad ?? row.aciklama ?? "");
  if (raw.includes("yarim") || raw.includes("yarım") || raw.includes("arefe")) return "half";
  return "full";
}
function holidayDateFromRow(row: Record<string, unknown>): string | null {
  const raw = String(row.tarih ?? row.date ?? row.gun ?? "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
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
    let m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
    m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    // Excel display format often arrives as m/d/yy (e.g. 3/2/26)
    m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      const mm = +m[1];
      const dd = +m[2];
      const yy = +m[3];
      const yyyy = yy < 100 ? 2000 + yy : yy;
      return new Date(yyyy, mm - 1, dd);
    }
    m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
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
  const [unmatchedRows, setUnmatchedRows] = useState<UnmatchedRow[]>([]);
  const [allMovements, setAllMovements] = useState<MovementRow[]>([]);
  const [importedRawMovements, setImportedRawMovements] = useState<MovementRow[]>([]);
  const [recalcVersion, setRecalcVersion] = useState(0);
  const calcRunRef = useRef(0);

  const [manualMovements, setManualMovements] = useState<MovementRow[]>([]);
  const [manualForm, setManualForm] = useState({
    personel: "",
    tarih: "",
    saat: "",
    durum: "G" as "G" | "C",
  });
  const [selectedMonth, setSelectedMonth] = useState("");

  async function processAll() {
    const runId = ++calcRunRef.current;
    setNotice("");
    setError("");
    try {
      if (!pdksFile) throw new Error("Ham PDKS dosyasi gerekli.");
      let rawMovements = importedRawMovements;
      if (rawMovements.length === 0) {
        const XLSX = await import("xlsx");
        const buf = await pdksFile.arrayBuffer();
        const ext = (pdksFile.name.split(".").pop() || "").toLowerCase();
        let rawSeq = 0;
        const parsed: MovementRow[] = [];

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
            parsed.push({
              id: `raw-${rawSeq++}`,
              source: "raw",
              personel: p,
              datetime: dt,
              durum: s as "G" | "C",
            });
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
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" }) as any[][];
            parseMovementRows(rows);
          });
        }
        rawMovements = parsed;
      }

      // Manuel eklenen hareketleri de ham akisa dahil et.
      const movements = [...rawMovements, ...manualMovements];
      const dedupedMovements = dedupeExactSameDirectionMovements(movements);
      const nextAllMovements = dedupedMovements.slice().sort((a, b) => {
        if (a.personel !== b.personel) return a.personel.localeCompare(b.personel, "tr");
        return a.datetime.getTime() - b.datetime.getTime();
      });

      // Pair G-C
      const byPerson = new Map<string, Array<{ datetime: Date; durum: "G" | "C" }>>();
      nextAllMovements.forEach((m) => {
        if (!byPerson.has(m.personel)) byPerson.set(m.personel, []);
        byPerson.get(m.personel)!.push({ datetime: m.datetime, durum: m.durum });
      });
      const pairs: PairRecord[] = [];
      const unmatched: UnmatchedRow[] = [];
      [...byPerson.entries()].forEach(([personel, list]) => {
        list.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
        let open: Date | null = null;
        list.forEach((x) => {
          if (x.durum === "G") {
            // Coklu giris gelirse onceki acik giris eslesememis sayilir.
            if (open) {
              unmatched.push({
                personel,
                tarih_saat: fmtISODateTime(open),
                durum: "G",
                neden: "Cikis bulunamadi (ardisik giris).",
              });
            }
            open = x.datetime;
            return;
          }
          if (!open) {
            unmatched.push({
              personel,
              tarih_saat: fmtISODateTime(x.datetime),
              durum: "C",
              neden: "Giris bulunamadi.",
            });
            return;
          }
          const diffMin = Math.round((x.datetime.getTime() - open.getTime()) / 60000);
          if (diffMin >= 0 && diffMin <= MAX_SHIFT_MIN) {
            // Ayni gun + geceyi asan (24:00 sonrasi) vardiyalar burada eslesir.
            pairs.push({ personel, giris: open, cikis: x.datetime });
          } else {
            unmatched.push({
              personel,
              tarih_saat: fmtISODateTime(open),
              durum: "G",
              neden: "Uygun cikis bulunamadi (sure limiti/asiri gec cikis).",
            });
            unmatched.push({
              personel,
              tarih_saat: fmtISODateTime(x.datetime),
              durum: "C",
              neden: "Giris-cikis suresi gecersiz.",
            });
          }
          open = null;
        });
        if (open) {
          unmatched.push({
            personel,
            tarih_saat: fmtISODateTime(open),
            durum: "G",
            neden: "Cikis bulunamadi.",
          });
        }
      });
      unmatched.sort((a, b) => (a.personel === b.personel ? a.tarih_saat.localeCompare(b.tarih_saat) : a.personel.localeCompare(b.personel, "tr")));

      // Mazeret map from existing app data (Supabase izinler + personel)
      const mazeretMap = new Map<string, string>();
      const holidayMap = new Map<string, "full" | "half">();
      if (hasSupabaseEnv) {
        try {
          const sb = getSupabaseClient();
          const [{ data: personeller }, { data: izinler }, resmiRes] = await Promise.all([
            sb.from("personel").select("id,ad,ise_giris,ayrilis_tarihi"),
            sb.from("izinler").select("personel_id,izin_tipi,baslangic,bitis"),
            sb.from("resmi_tatil_gunleri").select("*"),
          ]);
          const personelAdById = new Map((personeller ?? []).map((p) => [p.id, p.ad]));
          const personelCalismaAraligi = new Map(
            (personeller ?? []).map((p) => [normalizeText(p.ad), { ise: p.ise_giris, ayrilis: p.ayrilis_tarihi ?? null }]),
          );
          (izinler ?? []).forEach((i) => {
            const ad = personelAdById.get(i.personel_id);
            if (!ad) return;
            const from = new Date(i.baslangic + "T00:00:00");
            const to = new Date(i.bitis + "T00:00:00");
            for (let d = new Date(from); d.getTime() <= to.getTime(); d.setDate(d.getDate() + 1)) {
              mazeretMap.set(`${normalizeText(ad)}__${fmtDateKey(d)}`, i.izin_tipi);
            }
          });
          const allHolidayRows = ([...(resmiRes.data ?? [])] as Record<string, unknown>[]);
          const diniFullDays: string[] = [];
          allHolidayRows.forEach((row) => {
            const iso = holidayDateFromRow(row);
            if (!iso) return;
            const type = holidayTypeFromRow(row);
            if (!holidayMap.has(iso) || holidayMap.get(iso) !== "full") holidayMap.set(iso, type);
            const rawText = normalizeText(row.tur ?? row.tip ?? row.type ?? row.ad ?? row.aciklama ?? "");
            if (type === "full" && (rawText.includes("dini") || rawText.includes("ramazan") || rawText.includes("kurban"))) {
              diniFullDays.push(iso);
            }
          });
          // Dini tatillerin bir gun oncesi arefe: yarim gun.
          diniFullDays.forEach((iso) => {
            const prev = addDays(iso, -1);
            if (holidayMap.get(prev) !== "full") holidayMap.set(prev, "half");
          });
          // 29 Ekim oncesi yarim gun.
          [...holidayMap.entries()].forEach(([iso, type]) => {
            if (type !== "full") return;
            if (iso.slice(5) !== "10-29") return;
            const prev = addDays(iso, -1);
            if (holidayMap.get(prev) !== "full") holidayMap.set(prev, "half");
          });
          const withinEmployment = (personelAd: string, dayIso: string) => {
            const r = personelCalismaAraligi.get(normalizeText(personelAd));
            if (!r) return true;
            if (r.ise && dayIso < r.ise) return false;
            if (r.ayrilis && dayIso > r.ayrilis) return false;
            return true;
          };
          const filtered = nextAllMovements.filter((m) => withinEmployment(m.personel, fmtDateKey(m.datetime)));
          nextAllMovements.splice(0, nextAllMovements.length, ...filtered);
        } catch {
          // Mazeret okunamasa da duzeltme ekraninin hesaplari devam etsin.
        }
      }
      const nextMazeretCount = mazeretMap.size;

      // Daily/weekly calculations
      const byP = new Map<string, PairRecord[]>();
      pairs.forEach((p) => {
        if (!byP.has(p.personel)) byP.set(p.personel, []);
        byP.get(p.personel)!.push(p);
      });
      const sortedAllDays = [...new Set(nextAllMovements.map((m) => fmtDateKey(m.datetime)))].sort();
      const minDay = sortedAllDays[0] ?? "";
      const maxDay = sortedAllDays[sortedAllDays.length - 1] ?? "";
      const dRows: DailyRow[] = [];
      const wRows: WeeklyRow[] = [];
      [...byP.entries()].forEach(([personel, recs]) => {
        const byDay = new Map<string, PairRecord[]>();
        recs.forEach((r) => {
          const key = fmtDateKey(r.giris);
          if (!byDay.has(key)) byDay.set(key, []);
          byDay.get(key)!.push(r);
        });
        const weeks = new Map<string, { net: number; expected: number; etiket: string }>();
        const iterateDays: string[] = [];
        if (minDay && maxDay) {
          for (let d = new Date(`${minDay}T00:00:00`); fmtDateKey(d) <= maxDay; d.setDate(d.getDate() + 1)) {
            iterateDays.push(fmtDateKey(d));
          }
        }
        iterateDays.forEach((dayKey) => {
          const date = new Date(dayKey + "T00:00:00");
          const intervals = byDay.get(dayKey) ?? [];
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
          let lunch = 0;
          if (isWeekend(date)) {
            if (gross <= WEEKEND_LUNCH_ZERO_MAX_MIN) lunch = 0;
            else if (gross <= WEEKEND_LUNCH_HALF_MAX_MIN) lunch = 30;
            else lunch = FULL_LUNCH_MIN;
          } else {
            lunch = Math.max(0, FULL_LUNCH_MIN - outside);
          }
          const net = Math.max(0, gross - lunch);

          let expected = 0;
          if (!isSunday(date) && !isSaturday(date)) {
            const holiday = holidayMap.get(dayKey);
            if (holiday === "full") expected = 0;
            else expected = holiday === "half" ? HALF_DAY_TARGET_MIN : DAILY_TARGET_MIN;
            const mazeret = normalizeText(mazeretMap.get(`${normalizeText(personel)}__${dayKey}`) || "");
            // Izinler tablosunda kaydi olan tum mazeret/izin gunlerinde beklenen calisma sifirlanir.
            if (mazeret) expected = 0;
          }

          const ws = new Date(date);
          const day = ws.getDay();
          const diff = day === 0 ? -6 : 1 - day;
          ws.setDate(ws.getDate() + diff);
          const we = new Date(ws);
          we.setDate(we.getDate() + 6);
          const haftaKey = fmtDateKey(ws);
          const haftaEtiket = `${fmtDateKey(ws)} / ${fmtDateKey(we)}`;
          if (!weeks.has(haftaKey)) weeks.set(haftaKey, { net: 0, expected: 0, etiket: haftaEtiket });
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
        });

        [...weeks.entries()].forEach(([hafta, agg]) => {
          const bakiye = agg.net - agg.expected;
          wRows.push({
            personel,
            hafta,
            hafta_etiket: agg.etiket,
            haftalik_net: minutesToHHMM(agg.net),
            haftalik_beklenen: minutesToHHMM(agg.expected),
            haftalik_bakiye: minutesToHHMM(bakiye),
            haftalik_fazla_mesai: minutesToHHMM(Math.max(0, bakiye)),
          });
        });
      });

      dRows.sort((a, b) => (a.personel === b.personel ? a.tarih.localeCompare(b.tarih) : a.personel.localeCompare(b.personel, "tr")));
      wRows.sort((a, b) => (a.personel === b.personel ? a.hafta.localeCompare(b.hafta) : a.personel.localeCompare(b.personel, "tr")));
      const nextPersonCount = [...new Set(dRows.map((x) => x.personel))].length;
      if (runId !== calcRunRef.current) return;
      setImportedRawMovements(rawMovements);
      setAllMovements(nextAllMovements);
      setCleanRecords(pairs);
      setUnmatchedRows(unmatched);
      setPairCount(pairs.length);
      setMazeretCount(nextMazeretCount);
      setDailyRows(dRows);
      setWeeklyRows(wRows);
      setPersonCount(nextPersonCount);
      setNotice("Hesap tamamlandi.");
    } catch (e) {
      if (runId !== calcRunRef.current) return;
      setError(e instanceof Error ? e.message : "Islem sirasinda hata olustu.");
    }
  }

  function addManualMovement() {
    const personel = manualForm.personel.trim();
    const ok = addManualMovementFromValues(personel, manualForm.tarih, manualForm.saat, manualForm.durum);
    if (!ok) return;
    setManualForm((prev) => ({ ...prev, saat: "" }));
    setNotice("Manuel hareket eklendi.");
  }

  function removeManualMovement(index: number) {
    const target = manualMovements[index];
    if (!target) return;
    setManualMovements((prev) => prev.filter((_, i) => i !== index));
    setAllMovements((prev) => prev.filter((m) => m.id !== target.id));
    setRecalcVersion((v) => v + 1);
  }

  function addManualMovementFromValues(personelRaw: string, tarih: string, saat: string, durum: "G" | "C"): boolean {
    const personel = personelRaw.trim();
    if (!personel) {
      setError("Manuel hareket icin personel gerekli.");
      return false;
    }
    if (!tarih || !saat) {
      setError("Manuel hareket icin tarih ve saat gerekli.");
      return false;
    }
    const dt = new Date(`${tarih}T${saat}:00`);
    if (Number.isNaN(dt.getTime())) {
      setError("Manuel hareket tarihi/saati gecersiz.");
      return false;
    }
    const duplicate = manualMovements.some(
      (m) => normalizeText(m.personel) === normalizeText(personel)
        && m.datetime.getTime() === dt.getTime()
        && m.durum === durum,
    );
    if (duplicate) {
      setError("Ayni personel, tarih-saat ve durum icin manuel hareket zaten var.");
      return false;
    }
    setError("");
    const movement: MovementRow = {
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: "manual",
      personel,
      datetime: dt,
      durum,
    };
    setManualMovements((prev) => [...prev, movement]);
    setAllMovements((prev) => [...prev, movement]);
    setRecalcVersion((v) => v + 1);
    return true;
  }

  function prefillManualFormFromUnmatched(row: UnmatchedRow) {
    const [tarih = "", saat = ""] = row.tarih_saat.split(" ");
    setManualForm({
      personel: row.personel,
      tarih,
      saat,
      durum: row.durum === "G" ? "C" : "G",
    });
    setError("");
    setNotice("Duzeltme formu dolduruldu. Kontrol edip Hareket Ekle'ye basin.");
  }

  function quickFixFromUnmatched(row: UnmatchedRow) {
    const [tarih = "", saat = ""] = row.tarih_saat.split(" ");
    const hedefDurum: "G" | "C" = row.durum === "G" ? "C" : "G";
    const ok = addManualMovementFromValues(row.personel, tarih, saat, hedefDurum);
    if (!ok) return;
    setManualForm({
      personel: row.personel,
      tarih,
      saat,
      durum: hedefDurum,
    });
    setNotice("Duzelt + Ekle tamamlandi.");
  }

  function removeMovementFromDayList(row: MovementRow) {
    if (row.source === "manual") {
      setManualMovements((prev) => prev.filter((m) => m.id !== row.id));
    } else {
      setImportedRawMovements((prev) => prev.filter((m) => m.id !== row.id));
    }
    setAllMovements((prev) => prev.filter((m) => m.id !== row.id));
    setRecalcVersion((v) => v + 1);
    setNotice("Hareket listeden silindi.");
    setError("");
  }

  useEffect(() => {
    if (!pdksFile) return;
    void processAll();
  }, [pdksFile, recalcVersion]);

  const faultyDays = useMemo(() => {
    const map = new Map<string, { personel: string; tarih: string; reasons: Set<string>; count: number }>();
    unmatchedRows.forEach((r) => {
      const tarih = r.tarih_saat.split(" ")[0] || "";
      const key = `${normalizeText(r.personel)}__${tarih}`;
      if (!map.has(key)) {
        map.set(key, { personel: r.personel, tarih, reasons: new Set<string>(), count: 0 });
      }
      const item = map.get(key)!;
      item.reasons.add(r.neden);
      item.count += 1;
    });
    return [...map.values()].sort((a, b) => (a.personel === b.personel ? a.tarih.localeCompare(b.tarih) : a.personel.localeCompare(b.personel, "tr")));
  }, [unmatchedRows]);
  const selectedFormDayMovements = useMemo(() => {
    const personel = manualForm.personel.trim();
    const tarih = manualForm.tarih;
    if (!personel || !tarih) return [];
    return allMovements
      .filter((m) => normalizeText(m.personel) === normalizeText(personel) && fmtDateKey(m.datetime) === tarih)
      .sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
  }, [allMovements, manualForm.personel, manualForm.tarih]);
  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    dailyRows.forEach((r) => set.add(r.tarih.slice(0, 7)));
    return [...set].sort();
  }, [dailyRows]);
  useEffect(() => {
    if (monthOptions.length === 0) {
      if (selectedMonth) setSelectedMonth("");
      return;
    }
    if (selectedMonth && monthOptions.includes(selectedMonth)) return;
    const fromForm = manualForm.tarih ? manualForm.tarih.slice(0, 7) : "";
    if (fromForm && monthOptions.includes(fromForm)) {
      setSelectedMonth(fromForm);
      return;
    }
    setSelectedMonth(monthOptions[monthOptions.length - 1]);
  }, [monthOptions, selectedMonth, manualForm.tarih]);
  const monthlyBalanceRows = useMemo(() => {
    if (!selectedMonth) return [];
    const map = new Map<string, number>();
    dailyRows.forEach((r) => {
      if (!r.tarih.startsWith(selectedMonth)) return;
      const diff = hhmmToMinutes(r.net) - hhmmToMinutes(r.beklenen);
      map.set(r.personel, (map.get(r.personel) ?? 0) + diff);
    });
    return [...map.entries()]
      .map(([personel, bakiyeMin]) => ({ personel, bakiyeMin }))
      .sort((a, b) => a.personel.localeCompare(b.personel, "tr"));
  }, [dailyRows, selectedMonth]);
  const weeklyRowsForMonth = useMemo(() => {
    if (!selectedMonth) return weeklyRows;
    return weeklyRows.filter((r) => r.hafta_etiket.includes(selectedMonth));
  }, [weeklyRows, selectedMonth]);
  return (
    <div className="min-h-screen bg-slate-100/70 p-5 text-slate-900">
      <div className="mx-auto max-w-[1300px] space-y-5">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-2xl font-bold tracking-tight">PDKS - Puantaj Raporu</h1>
          <p className="mt-2 text-sm text-slate-500">Bu ekranda sadece hatali gunleri tespit edip, secili gun kayitlarini duzeltebilirsiniz.</p>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ham PDKS Dosyasi</p>
              <input className="mt-3 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm" type="file" accept=".csv,.xls,.xlsx" onChange={(e) => {
                setPdksFile(e.target.files?.[0] ?? null);
                setImportedRawMovements([]);
                setAllMovements([]);
                setManualMovements([]);
              }} />
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Eslesmeyen Kayit</p>
              <div className="mt-2 text-3xl font-bold tracking-tight">{unmatchedRows.length}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Personel / Mazeret</p>
              <div className="mt-2 text-xl font-bold tracking-tight">{personCount} / {mazeretCount}</div>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-slate-800" onClick={() => void processAll()}>Hesapla</button>
          </div>
          {notice ? <div className="mt-3 rounded-lg bg-emerald-50 p-3 text-emerald-700">{notice}</div> : null}
          {error ? <div className="mt-3 rounded-lg bg-rose-50 p-3 text-rose-700">{error}</div> : null}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold tracking-tight">Hatali Gunler</h2>
          <p className="mt-1 text-sm text-slate-500">Sadece eslesmeyen veri olan personel ve gunler listelenir.</p>
          <div className="mt-3 max-h-64 overflow-auto rounded-xl border border-slate-200">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  <th className="border-b p-2 text-left">Personel</th>
                  <th className="border-b p-2 text-left">Gun</th>
                  <th className="border-b p-2 text-right">Islem</th>
                </tr>
              </thead>
              <tbody>
                {faultyDays.length === 0 ? (
                  <tr>
                    <td className="p-2 text-slate-500" colSpan={3}>Hatali gun bulunamadi.</td>
                  </tr>
                ) : (
                  faultyDays.map((d, idx) => (
                    <tr key={`${d.personel}-${d.tarih}-${idx}`}>
                      <td className="border-b p-2">{d.personel}</td>
                      <td className="border-b p-2">{d.tarih}</td>
                      <td className="border-b p-2 text-right">
                        <button
                          className="rounded-md border border-sky-200 px-2 py-1 text-sky-700 hover:bg-sky-50"
                          onClick={() => setManualForm((prev) => ({ ...prev, personel: d.personel, tarih: d.tarih }))}
                        >
                          Duzenle
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold tracking-tight">Ek Hareket Tanimla</h2>
          <p className="mt-1 text-sm text-slate-500">Eksik/yanlis PDKS satirlarini manuel ekleyip hesaplamaya katabilirsiniz.</p>
          <div className="mt-3 grid gap-3 md:grid-cols-5">
            <input
              className="rounded-xl border border-slate-300 bg-white p-2.5 text-sm"
              placeholder="Personel"
              value={manualForm.personel}
              onChange={(e) => setManualForm((prev) => ({ ...prev, personel: e.target.value }))}
            />
            <input
              className="rounded-xl border border-slate-300 bg-white p-2.5 text-sm"
              type="date"
              value={manualForm.tarih}
              onChange={(e) => setManualForm((prev) => ({ ...prev, tarih: e.target.value }))}
            />
            <input
              className="rounded-xl border border-slate-300 bg-white p-2.5 text-sm"
              type="time"
              value={manualForm.saat}
              onChange={(e) => setManualForm((prev) => ({ ...prev, saat: e.target.value }))}
            />
            <select
              className="rounded-xl border border-slate-300 bg-white p-2.5 text-sm"
              value={manualForm.durum}
              onChange={(e) => setManualForm((prev) => ({ ...prev, durum: e.target.value as "G" | "C" }))}
            >
              <option value="G">Giris (G)</option>
              <option value="C">Cikis (C)</option>
            </select>
            <button className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-50" onClick={addManualMovement}>
              Hareket Ekle
            </button>
          </div>
          <div className="mt-3 rounded-xl border border-slate-200">
            <div className="border-b bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">
              Secilen Personel + Gun Hareketleri
            </div>
            {!manualForm.personel.trim() || !manualForm.tarih ? (
              <div className="p-3 text-xs text-slate-500">
                Listelenmesi icin Personel ve Tarih secin.
              </div>
            ) : null}
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 bg-slate-50">
                  <tr>
                    <th className="border-b p-2 text-left">Personel</th>
                    <th className="border-b p-2 text-left">Tarih Saat</th>
                    <th className="border-b p-2 text-left">Durum</th>
                    <th className="border-b p-2 text-right">Islem</th>
                  </tr>
                </thead>
                <tbody>
                  {manualForm.personel.trim() && manualForm.tarih && selectedFormDayMovements.length === 0 ? (
                    <tr>
                      <td className="p-2 text-slate-500" colSpan={4}>Bu kisi ve gun icin hareket bulunamadi.</td>
                    </tr>
                  ) : (
                    selectedFormDayMovements.map((m, idx) => (
                      <tr key={`${m.id}-${idx}`} className={m.durum === "C" ? "bg-rose-50/70" : "bg-white"}>
                        <td className="border-b p-2">{m.personel}</td>
                        <td className="border-b p-2">{fmtISODateTime(m.datetime)}</td>
                        <td className="border-b p-2">{m.durum}</td>
                        <td className="border-b p-2 text-right">
                          <button
                            className="rounded-md border border-rose-200 px-2 py-1 text-rose-700 hover:bg-rose-50"
                            onClick={() => removeMovementFromDayList(m)}
                          >
                            Sil
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold tracking-tight">Haftalik Calisma ve Fazla Mesai</h2>
          <p className="mt-1 text-sm text-slate-500">Pazartesi baslangicli hafta toplamlari ve secili ay icin personel bazli +/- bakiye.</p>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs text-slate-500">Ay:</span>
            <select
              className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
            >
              {monthOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="mt-3 max-h-52 overflow-auto rounded-xl border border-slate-200">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  <th className="border-b p-2 text-left">Personel</th>
                  <th className="border-b p-2 text-right">Aylik Bakiye (+/-)</th>
                </tr>
              </thead>
              <tbody>
                {monthlyBalanceRows.length === 0 ? (
                  <tr>
                    <td className="p-2 text-slate-500" colSpan={2}>Secili ay icin bakiye yok.</td>
                  </tr>
                ) : (
                  monthlyBalanceRows.map((r) => (
                    <tr key={`${r.personel}-${selectedMonth}`}>
                      <td className="border-b p-2">{r.personel}</td>
                      <td className={`border-b p-2 text-right font-semibold ${r.bakiyeMin >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                        {minutesToHHMM(r.bakiyeMin)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3 max-h-80 overflow-auto rounded-xl border border-slate-200">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  <th className="border-b p-2 text-left">Personel</th>
                  <th className="border-b p-2 text-left">Hafta</th>
                  <th className="border-b p-2 text-right">Net Calisma</th>
                  <th className="border-b p-2 text-right">Beklenen</th>
                  <th className="border-b p-2 text-right">Bakiye (+/-)</th>
                  <th className="border-b p-2 text-right">Fazla Mesai (+)</th>
                </tr>
              </thead>
              <tbody>
                {weeklyRowsForMonth.length === 0 ? (
                  <tr>
                    <td className="p-2 text-slate-500" colSpan={6}>Haftalik sonuc yok.</td>
                  </tr>
                ) : (
                  weeklyRowsForMonth.map((r) => (
                    <tr key={`${r.personel}-${r.hafta}`}>
                      <td className="border-b p-2">{r.personel}</td>
                      <td className="border-b p-2">{r.hafta_etiket}</td>
                      <td className="border-b p-2 text-right">{r.haftalik_net}</td>
                      <td className="border-b p-2 text-right">{r.haftalik_beklenen}</td>
                      <td className={`border-b p-2 text-right font-semibold ${r.haftalik_bakiye.startsWith("-") ? "text-rose-700" : "text-emerald-700"}`}>{r.haftalik_bakiye}</td>
                      <td className="border-b p-2 text-right font-semibold text-emerald-700">{r.haftalik_fazla_mesai}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

      </div>
    </div>
  );
}

