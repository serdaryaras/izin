"use client";

import {
  type ChangeEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Database, getSupabaseClient, hasSupabaseEnv } from "@/lib/supabase";

type Cinsiyet = "K" | "E";
type IzinKod = "yillik" | "rapor" | "dis" | "evlilik" | "cenaze" | "dogum";

type Personel = {
  id: string;
  ad: string;
  dogum_tarihi: string;
  ise_giris: string;
  ayrilis_tarihi: string | null;
  cinsiyet: Cinsiyet;
  devir_onceki_kullanilan_izin: number | null;
};

type IzinTuru = {
  kod: IzinKod;
  ad: string;
  yillik_izinden_duser: boolean;
  varsayilan_hak_gun: number | null;
  cinsiyet_bagli: boolean;
};

type Izin = {
  id: string;
  personel_id: string;
  izin_tipi: IzinKod;
  baslangic: string;
  bitis: string;
  gun_sayisi: number | null;
  gun: number | null;
  aciklama: string | null;
};

type Tatil = {
  tarih: string;
  tur: string;
};

type PersonelForm = {
  ad: string;
  dogum_tarihi: string;
  ise_giris: string;
  ayrilis_tarihi: string;
  cinsiyet: Cinsiyet;
};

type IzinForm = {
  personel_id: string;
  /** Arama kutusuyla uyum: yazilan metin secili tur adiyla eslesmeyince bos */
  izin_tipi: IzinKod | "";
  baslangic: string;
  bitis: string;
  aciklama: string;
};

const izinKisaltma: Record<IzinKod, string> = {
  yillik: "Y",
  rapor: "R",
  dis: "D",
  evlilik: "E",
  cenaze: "C",
  dogum: "DG",
};

const izinRenk: Record<IzinKod, string> = {
  yillik: "bg-sky-500 text-white",
  rapor: "bg-pink-500 text-white",
  dis: "bg-amber-500 text-white",
  evlilik: "bg-purple-500 text-white",
  cenaze: "bg-slate-500 text-white",
  dogum: "bg-emerald-500 text-white",
};

/** Mazeret giris karti: secilen turun rengine yakin acik ton (takvim rozetleriyle eslenik) */
const mazeretFormArkaplan: Record<IzinKod, string> = {
  yillik: "bg-sky-100/70",
  rapor: "bg-pink-100/70",
  dis: "bg-amber-100/80",
  evlilik: "bg-purple-100/75",
  cenaze: "bg-slate-100",
  dogum: "bg-emerald-100/75",
};

const bugun = new Date();

/** Supabase yyyy-mm-dd -> gg.aa.yyyy gorunum */
function isoToDdMmYyyy(iso: string): string {
  if (!iso || iso.length < 10) return "";
  const [y, mo, da] = iso.slice(0, 10).split("-");
  if (!y || !mo || !da) return "";
  return `${da}.${mo}.${y}`;
}

function dosyaAdiGuvenli(ad: string): string {
  const s = ad
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_");
  return (s.length > 0 ? s : "personel").slice(0, 80);
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/** Sadece rakam, nokta ve tire; cift ayrici tekillestirilir (gg.aa.yyyy veya g-a-yyyy). */
function maskDateInputFlexible(raw: string): string {
  let s = raw.replace(/[^\d.\-]/g, "");
  s = s.replace(/([.\-])[.\-]+/g, "$1");
  return s.slice(0, 10);
}

/**
 * Tam secilen metin ekrandayken sonuna eklenen yaziyi yapistirma:
 * or. "ülkem ünlü" + "em" -> yalnizca "em" (yeni arama), secim sifirlanir.
 */
function combValueAfterFullSelection(raw: string, fullLabel: string, prevShown: string): string {
  if (!fullLabel) return raw;
  if (prevShown !== fullLabel) return raw;
  if (raw.length <= fullLabel.length) return raw;
  if (!raw.startsWith(fullLabel)) return raw;
  return raw.slice(fullLabel.length).replace(/^\s+/, "");
}

/** gg.aa.yyyy veya g-a-yyyy (1-2 hane gun/ay); gecerliyse yyyy-mm-dd */
function ddMmYyyyToIso(tr: string): string | null {
  const t = tr.replace(/\u00a0/g, " ").trim();
  if (!t) return null;

  // Metin icinde tarih geciyorsa (or. "27.02.2017 Sal"), tarih parcasi yakalanir.
  let m = /(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/.exec(t);
  let day: number;
  let month: number;
  let year: number;
  if (m) {
    day = Number(m[1]);
    month = Number(m[2]);
    year = Number(m[3]);
  } else {
    const ymd = /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/.exec(t);
    if (!ymd) return null;
    year = Number(ymd[1]);
    month = Number(ymd[2]);
    day = Number(ymd[3]);
  }

  const dt = new Date(year, month - 1, day);
  if (
    dt.getFullYear() !== year ||
    dt.getMonth() !== month - 1 ||
    dt.getDate() !== day
  ) {
    return null;
  }
  return toISODate(dt);
}

function adKeyTr(s: string): string {
  return s.trim().toLocaleLowerCase("tr").replace(/\s+/g, " ");
}

/** Excel hucre: metin gg.aa.yyyy, Excel seri sayisi veya Date */
function hucreyiTarihMetnine(v: unknown): string {
  if (v == null || v === "") return "";
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // XLSX cellDates ile gelen Date degerleri yerel gunde yorumlanir.
    // UTC parcasi kullanmak +03 gibi timezone'larda bir gun geri kaydirabilir.
    return `${v.getDate()}.${v.getMonth() + 1}.${v.getFullYear()}`;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getUTCDate()}.${d.getUTCMonth() + 1}.${d.getUTCFullYear()}`;
    }
  }
  return String(v).trim().replace(/\//g, ".");
}

function personelBulAdla(personeller: Personel[], ad: string): Personel | null {
  const k = adKeyTr(ad);
  if (!k) return null;
  const uygun = personeller.filter((p) => adKeyTr(p.ad) === k);
  return uygun[0] ?? null;
}

/** D bos veya yok: yillik; aksi halde tablo izin turu adi veya bilinen kisa ad */
function turKoduHucreden(ham: unknown, turler: IzinTuru[]): IzinKod | null {
  const s = String(ham ?? "").trim();
  if (!s) return "yillik";
  const k = s.toLocaleLowerCase("tr");
  for (const t of turler) {
    if (t.ad.toLocaleLowerCase("tr") === k) return t.kod;
  }
  const alias: Record<string, IzinKod> = {
    yillik: "yillik",
    yıllık: "yillik",
    "yillik izin": "yillik",
    "yıllık izin": "yillik",
    rapor: "rapor",
    dis: "dis",
    disarida: "dis",
    "disarida calisma": "dis",
    "dışarıda calisma": "dis",
    "dışarıda çalışma": "dis",
    evlilik: "evlilik",
    cenaze: "cenaze",
    dogum: "dogum",
    doğum: "dogum",
  };
  return alias[k] ?? null;
}

function toISODate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseISODate(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

function startOfMonth(year: number, monthIndex: number): Date {
  return new Date(year, monthIndex, 1);
}

function endOfMonth(year: number, monthIndex: number): Date {
  return new Date(year, monthIndex + 1, 0);
}

function diffYears(startIso: string, end: Date): number {
  const start = parseISODate(startIso);
  let years = end.getFullYear() - start.getFullYear();
  const m = end.getMonth() - start.getMonth();
  if (m < 0 || (m === 0 && end.getDate() < start.getDate())) {
    years -= 1;
  }
  return Math.max(0, years);
}

function yearFromIso(iso: string): number {
  return Number(iso.slice(0, 4));
}

function endOfCalendarYearIso(y: number): string {
  return `${y}-12-31`;
}

/** Kidem/yas kurallarina gore yillik hak (gun) */
function annualEntitlementByRules(kidemYil: number, yas: number): number {
  /**
   * Hak yil donumunde dogdugu icin band hesabinda 1 yil kaydirma uygulanir:
   * 1..5. hak yili => 14, 6..15. hak yili => 20, 16+ => 26.
   */
  const bandKidem = Math.max(0, kidemYil - 1);
  let hak = 14;
  if (bandKidem >= 5 && bandKidem < 15) hak = 20;
  if (bandKidem >= 15) hak = 26;
  if (yas < 18 || yas >= 50) hak = Math.max(hak, 20);
  return hak;
}

/**
 * Yillik hak, ancak en az 1 tam yil tamamlandiginda dogar.
 * grantDate: hakkin dogdugu tarih (ise giris yil donumu).
 */
function calculateAnnualEntitlementAtGrantDate(personel: Personel, grantDate: Date): number {
  const kidem = diffYears(personel.ise_giris, grantDate);
  if (kidem < 1) return 0;
  const yas = diffYears(personel.dogum_tarihi, grantDate);
  return annualEntitlementByRules(kidem, yas);
}

/** Ise giristen, verilen tarihe kadar olusan tum yillik haklarin toplami. */
function cumulativeAnnualEntitlementThroughDate(
  personel: Personel,
  throughDate: Date,
): number {
  const hire = parseISODate(personel.ise_giris);
  const leaveDate = personel.ayrilis_tarihi ? parseISODate(personel.ayrilis_tarihi) : null;
  const cutoff =
    leaveDate && leaveDate.getTime() < throughDate.getTime() ? leaveDate : throughDate;
  let sum = 0;
  for (let n = 1; n <= 80; n++) {
    const grantDate = new Date(
      hire.getFullYear() + n,
      hire.getMonth(),
      hire.getDate(),
    );
    if (grantDate.getTime() > cutoff.getTime()) break;
    sum += calculateAnnualEntitlementAtGrantDate(personel, grantDate);
  }
  return sum;
}

/**
 * Sistemdeki yillik izin kayitlari + devir oncesi kullanilan (tablo alani) ile
 * kumulatif kullanilan gunler (verilen tarihe kadar, arefe/pazar/tatil kurallariyla).
 */
function cumulativeAnnualUsedThroughDate(
  personel: Personel,
  throughDate: Date,
  allIzinler: Izin[],
  tatilMap: Map<string, string>,
): number {
  const endIso = toISODate(throughDate);
  const iseGiris = personel.ise_giris;
  let sum = 0;
  for (const i of allIzinler) {
    if (i.personel_id !== personel.id || i.izin_tipi !== "yillik") continue;
    if (i.bitis < iseGiris || i.baslangic > endIso) continue;
    const from = i.baslangic > iseGiris ? i.baslangic : iseGiris;
    const to = i.bitis < endIso ? i.bitis : endIso;
    if (from <= to) sum += yearlyLeaveCharge(from, to, tatilMap);
  }
  sum += Number(personel.devir_onceki_kullanilan_izin ?? 0);
  return sum;
}

/**
 * Ise giris yildonumundan baslayan kidem yili [bas, son] (inclusive),
 * secilen takvim ayinin icindeki bir gune denk gelen donem.
 */
function workYearBoundsContainingMonth(
  iseGirisIso: string,
  calendarYear: number,
  monthIndex: number,
): { bas: string; son: string } | null {
  const hire = parseISODate(iseGirisIso);
  const ref = new Date(calendarYear, monthIndex, 15);
  if (ref.getTime() < hire.getTime()) return null;
  const hy = hire.getFullYear();
  const hm = hire.getMonth();
  const hd = hire.getDate();
  let n = ref.getFullYear() - hy;
  const anniversaryThisCalendarYear = new Date(calendarYear, hm, hd);
  if (ref.getTime() < anniversaryThisCalendarYear.getTime()) n -= 1;
  const bas = new Date(hy + n, hm, hd);
  const sonExclusive = new Date(hy + n + 1, hm, hd);
  const son = new Date(sonExclusive.getTime() - 86400000);
  return { bas: toISODate(bas), son: toISODate(son) };
}

function daterange(fromIso: string, toIso: string): string[] {
  const from = parseISODate(fromIso);
  const to = parseISODate(toIso);
  const out: string[] = [];
  for (
    let d = new Date(from);
    d.getTime() <= to.getTime();
    d.setDate(d.getDate() + 1)
  ) {
    out.push(toISODate(d));
  }
  return out;
}

function yearlyLeaveCharge(
  fromIso: string,
  toIso: string,
  tatilMap: Map<string, string>,
): number {
  let toplam = 0;
  for (const day of daterange(fromIso, toIso)) {
    const d = parseISODate(day);
    const tur = tatilMap.get(day);
    if (isSunday(d) || tur === "resmi_tatil") continue;
    if (isHalfDay(day, tur)) {
      toplam += 0.5;
      continue;
    }
    toplam += 1;
  }
  return toplam;
}

function shouldShowOnDay(
  izin: Izin,
  dayIso: string,
  tatilTur?: string,
): boolean {
  const d = parseISODate(dayIso);
  if (isSunday(d) || tatilTur === "resmi_tatil") return false;
  return dayIso >= izin.baslangic && dayIso <= izin.bitis;
}

function annualLeaveUsedInIsoRange(
  personel: Personel,
  rangeBas: string,
  rangeSon: string,
  allIzinler: Izin[],
  tatilMap: Map<string, string>,
): number {
  let sum = 0;
  for (const i of allIzinler) {
    if (i.personel_id !== personel.id || i.izin_tipi !== "yillik") continue;
    if (i.bitis < rangeBas || i.baslangic > rangeSon) continue;
    const from = i.baslangic > rangeBas ? i.baslangic : rangeBas;
    const to = i.bitis < rangeSon ? i.bitis : rangeSon;
    if (from <= to) sum += yearlyLeaveCharge(from, to, tatilMap);
  }
  return sum;
}

function isSunday(date: Date): boolean {
  return date.getDay() === 0;
}

function isHalfDay(dayIso: string, tur?: string): boolean {
  return tur === "arefe_yarim" || dayIso.endsWith("-10-28");
}

/** Pazartesi = 0 ... Pazar = 6 */
function mondayBasedDayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/** ISO 8601 hafta numarasi (Pazartesi baslar) */
function isoWeekFromDate(d: Date): number {
  const tmp = new Date(d.getTime());
  tmp.setHours(0, 0, 0, 0);
  tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));
  const week1 = new Date(tmp.getFullYear(), 0, 4);
  return (
    1 +
    Math.round(
      ((tmp.getTime() - week1.getTime()) / 86400000 -
        3 +
        ((week1.getDay() + 6) % 7)) /
        7,
    )
  );
}

/** Ay grid'i: en fazla 6 satir (padding dahil) */
function monthWeekGrid(year: number, monthIndex: number): { weekNo: number; days: Date[] }[] {
  const first = new Date(year, monthIndex, 1);
  const last = new Date(year, monthIndex + 1, 0);
  const pad = mondayBasedDayIndex(first);
  const d = new Date(year, monthIndex, 1 - pad);
  const rows: { weekNo: number; days: Date[] }[] = [];
  for (let r = 0; r < 6; r++) {
    const days: Date[] = [];
    for (let i = 0; i < 7; i++) {
      days.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    rows.push({ weekNo: isoWeekFromDate(days[0]), days });
    if (days[0] > last) break;
  }
  return rows;
}

function personelAktifMi(p: Personel): boolean {
  const a = p.ayrilis_tarihi;
  return a == null || String(a).trim() === "";
}

async function captureTakvimElement(el: HTMLElement): Promise<HTMLCanvasElement> {
  const { domToCanvas } = await import("modern-screenshot");
  const wrap = el.querySelector("[data-takvim-table-wrap]");
  if (wrap instanceof HTMLElement) {
    const prev = wrap.style.cssText;
    wrap.style.overflow = "visible";
    wrap.style.maxHeight = "none";
    try {
      return await domToCanvas(el, {
        scale: 2,
        backgroundColor: "#ffffff",
      });
    } finally {
      wrap.style.cssText = prev;
    }
  }
  return domToCanvas(el, {
    scale: 2,
    backgroundColor: "#ffffff",
  });
}

function indirCanvasPng(canvas: HTMLCanvasElement, dosyaAdi: string) {
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = dosyaAdi;
  a.click();
}

async function indirTakvimPdf(canvas: HTMLCanvasElement, dosyaAdi: string) {
  const { default: jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 8;
  const imgData = canvas.toDataURL("image/png");
  const iw = canvas.width;
  const ih = canvas.height;
  const maxW = pageW - 2 * margin;
  const maxH = pageH - 2 * margin;
  const r = Math.min(maxW / iw, maxH / ih);
  const dw = iw * r;
  const dh = ih * r;
  const x = margin + (maxW - dw) / 2;
  const y = margin + (maxH - dh) / 2;
  pdf.addImage(imgData, "PNG", x, y, dw, dh);
  pdf.save(dosyaAdi);
}

export default function Home() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>("");
  const [info, setInfo] = useState<string>("");

  const [personeller, setPersoneller] = useState<Personel[]>([]);
  const [izinTurleri, setIzinTurleri] = useState<IzinTuru[]>([]);
  const [izinler, setIzinler] = useState<Izin[]>([]);
  const [tatiller, setTatiller] = useState<Tatil[]>([]);

  const [selectedPersonelId, setSelectedPersonelId] = useState<string>("");
  /** takvim: personel listesi kaynagi */
  const [takvimKaynak, setTakvimKaynak] = useState<"aktif" | "tumu">("aktif");
  /** tumu: kapsamdaki herkes; secili: sadece isaretlenenler */
  const [takvimGorunum, setTakvimGorunum] = useState<"havuz_tumu" | "secili">(
    "havuz_tumu",
  );
  const [takvimSeciliIds, setTakvimSeciliIds] = useState<string[]>([]);
  const [month, setMonth] = useState<number>(bugun.getMonth());
  const [year, setYear] = useState<number>(bugun.getFullYear());

  const [personelForm, setPersonelForm] = useState<PersonelForm>({
    ad: "",
    dogum_tarihi: "",
    ise_giris: "",
    ayrilis_tarihi: "",
    cinsiyet: "E",
  });

  const [izinForm, setIzinForm] = useState<IzinForm>({
    personel_id: "",
    izin_tipi: "yillik",
    baslangic: "",
    bitis: "",
    aciklama: "",
  });
  /** Yillik mazeret takviminde gosterilen yil */
  const [mazeretTakvimYil, setMazeretTakvimYil] = useState<number>(() => bugun.getFullYear());
  /**
   * Aralik secimi: ilk tikta yer lestirilir; ikinci tikta aralik tamamlanir.
   * null = yeni secime hazir.
   */
  const [mazeretTakvimBirinciGun, setMazeretTakvimBirinciGun] = useState<string | null>(null);
  const [mazeretPersonelArama, setMazeretPersonelArama] = useState("");
  const [mazeretPersonelListeAcik, setMazeretPersonelListeAcik] = useState(false);
  const mazeretPersonelKutuRef = useRef<HTMLDivElement>(null);
  const [mazeretTurArama, setMazeretTurArama] = useState("");
  const [mazeretTurListeAcik, setMazeretTurListeAcik] = useState(false);
  const mazeretTurKutuRef = useRef<HTMLDivElement>(null);
  const [mazeretFormMesaj, setMazeretFormMesaj] = useState<{
    text: string;
    tip: "ok" | "err";
  } | null>(null);
  const excelIzinInputRef = useRef<HTMLInputElement>(null);
  const [excelIzinYukleniyor, setExcelIzinYukleniyor] = useState(false);
  const [excelIzinRaporu, setExcelIzinRaporu] = useState<{
    eklenen: number;
    hatalar: string[];
  } | null>(null);
  const takvimExportRef = useRef<HTMLDivElement>(null);
  const [takvimDisariAktariliyor, setTakvimDisariAktariliyor] = useState(false);

  async function loadData() {
    if (!hasSupabaseEnv) {
      setError("Supabase env eksik. .env.local dosyasini doldurun.");
      setLoading(false);
      return;
    }

    const sb = getSupabaseClient();
    if (!sb) {
      setError("Supabase baglantisi kurulamadi.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");
    const [pRes, tRes, iRes, hRes] = await Promise.all([
      sb
        .from("personel")
        .select(
          "id, ad, dogum_tarihi, ise_giris, ayrilis_tarihi, cinsiyet, devir_onceki_kullanilan_izin",
        )
        .order("ad", { ascending: true }),
      sb
        .from("izin_turleri")
        .select("kod, ad, yillik_izinden_duser, varsayilan_hak_gun, cinsiyet_bagli"),
      sb
        .from("izinler")
        .select("id, personel_id, izin_tipi, baslangic, bitis, gun_sayisi, gun, aciklama"),
      sb.from("resmi_tatil_gunleri").select("tarih, tur"),
    ]);

    if (pRes.error || tRes.error || iRes.error || hRes.error) {
      setError(
        pRes.error?.message ||
          tRes.error?.message ||
          iRes.error?.message ||
          hRes.error?.message ||
          "Veri okunamadi.",
      );
      setLoading(false);
      return;
    }

    const pList = (pRes.data ?? []) as Personel[];
    const izinTurleriRaw = (tRes.data ?? []) as IzinTuru[];
    const varsayilanTurler: IzinTuru[] = [
      { kod: "yillik", ad: "Yillik Izin", yillik_izinden_duser: true, varsayilan_hak_gun: null, cinsiyet_bagli: false },
      { kod: "rapor", ad: "Rapor", yillik_izinden_duser: false, varsayilan_hak_gun: null, cinsiyet_bagli: false },
      { kod: "dis", ad: "Disarida Calisma", yillik_izinden_duser: false, varsayilan_hak_gun: null, cinsiyet_bagli: false },
      { kod: "evlilik", ad: "Evlilik", yillik_izinden_duser: false, varsayilan_hak_gun: 3, cinsiyet_bagli: false },
      { kod: "cenaze", ad: "Cenaze", yillik_izinden_duser: false, varsayilan_hak_gun: 3, cinsiyet_bagli: false },
      { kod: "dogum", ad: "Dogum", yillik_izinden_duser: false, varsayilan_hak_gun: null, cinsiyet_bagli: true },
    ];
    const byKod = new Map(izinTurleriRaw.map((x) => [x.kod, x]));
    const turList = varsayilanTurler.map((x) => byKod.get(x.kod) ?? x);

    setPersoneller(pList);
    setIzinTurleri(turList);
    setIzinler((iRes.data ?? []) as Izin[]);
    setTatiller((hRes.data ?? []) as Tatil[]);
    setSelectedPersonelId((prev) =>
      prev && pList.some((p) => p.id === prev) ? prev : "",
    );
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData();
  }, []);

  useEffect(() => {
    const selected = personeller.find((p) => p.id === selectedPersonelId);
    if (!selectedPersonelId || !selected) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPersonelForm({
        ad: "",
        dogum_tarihi: "",
        ise_giris: "",
        ayrilis_tarihi: "",
        cinsiyet: "E",
      });
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPersonelForm({
      ad: selected.ad,
      dogum_tarihi: isoToDdMmYyyy(selected.dogum_tarihi),
      ise_giris: isoToDdMmYyyy(selected.ise_giris),
      ayrilis_tarihi: selected.ayrilis_tarihi ? isoToDdMmYyyy(selected.ayrilis_tarihi) : "",
      cinsiyet: selected.cinsiyet ?? "E",
    });
  }, [selectedPersonelId, personeller]);

  const takvimPersonelHavuzu = useMemo(() => {
    return takvimKaynak === "aktif"
      ? personeller.filter(personelAktifMi)
      : personeller;
  }, [personeller, takvimKaynak]);

  useEffect(() => {
    setTakvimSeciliIds((prev) => prev.filter((id) => takvimPersonelHavuzu.some((p) => p.id === id)));
  }, [takvimPersonelHavuzu]);

  const mazeretPersonelFiltre = useMemo(() => {
    const q = mazeretPersonelArama.trim().toLocaleLowerCase("tr");
    if (!q) return personeller;
    return personeller.filter((p) => p.ad.toLocaleLowerCase("tr").includes(q));
  }, [personeller, mazeretPersonelArama]);

  useEffect(() => {
    const p = personeller.find((x) => x.id === izinForm.personel_id);
    if (izinForm.personel_id && p) setMazeretPersonelArama(p.ad);
  }, [izinForm.personel_id, personeller]);

  useEffect(() => {
    const t = izinTurleri.find((x) => x.kod === izinForm.izin_tipi);
    if (izinForm.izin_tipi && t) setMazeretTurArama(t.ad);
  }, [izinForm.izin_tipi, izinTurleri]);

  const mazeretTurFiltre = useMemo(() => {
    const q = mazeretTurArama.trim().toLocaleLowerCase("tr");
    if (!q) return izinTurleri;
    return izinTurleri.filter((t) => t.ad.toLocaleLowerCase("tr").includes(q));
  }, [izinTurleri, mazeretTurArama]);

  /** Suzmede tek personel kalinca otomatik sec */
  useEffect(() => {
    const q = mazeretPersonelArama.trim();
    if (!q) return;
    if (mazeretPersonelFiltre.length !== 1) return;
    const only = mazeretPersonelFiltre[0];
    if (izinForm.personel_id === only.id) {
      if (mazeretPersonelArama !== only.ad) {
        setMazeretPersonelArama(only.ad);
        setMazeretPersonelListeAcik(false);
      }
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIzinForm((prev) => ({ ...prev, personel_id: only.id }));
    setMazeretPersonelArama(only.ad);
    setMazeretPersonelListeAcik(false);
  }, [mazeretPersonelFiltre, mazeretPersonelArama, izinForm.personel_id]);

  /** Suzmede tek mazeret turu kalinca otomatik sec */
  useEffect(() => {
    const q = mazeretTurArama.trim();
    if (!q) return;
    if (mazeretTurFiltre.length !== 1) return;
    const only = mazeretTurFiltre[0];
    if (izinForm.izin_tipi === only.kod) {
      if (mazeretTurArama !== only.ad) {
        setMazeretTurArama(only.ad);
        setMazeretTurListeAcik(false);
      }
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIzinForm((prev) => ({ ...prev, izin_tipi: only.kod }));
    setMazeretTurArama(only.ad);
    setMazeretTurListeAcik(false);
  }, [mazeretTurFiltre, mazeretTurArama, izinForm.izin_tipi]);

  useEffect(() => {
    if (!mazeretPersonelListeAcik) return;
    const fn = (e: MouseEvent) => {
      if (
        mazeretPersonelKutuRef.current &&
        !mazeretPersonelKutuRef.current.contains(e.target as Node)
      ) {
        setMazeretPersonelListeAcik(false);
      }
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [mazeretPersonelListeAcik]);

  useEffect(() => {
    if (!mazeretTurListeAcik) return;
    const fn = (e: MouseEvent) => {
      if (
        mazeretTurKutuRef.current &&
        !mazeretTurKutuRef.current.contains(e.target as Node)
      ) {
        setMazeretTurListeAcik(false);
      }
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [mazeretTurListeAcik]);

  useEffect(() => {
    const formEtiketleri = new Set(["INPUT", "TEXTAREA", "SELECT"]);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const raw = e.target;
      if (!(raw instanceof HTMLElement)) return;
      if (formEtiketleri.has(raw.tagName) || raw.isContentEditable) return;
      e.preventDefault();
      const delta = e.key === "ArrowLeft" ? -1 : 1;
      setMonth((prevM) => {
        const next = prevM + delta;
        if (next < 0) {
          setYear((y) => y - 1);
          return 11;
        }
        if (next > 11) {
          setYear((y) => y + 1);
          return 0;
        }
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tatilMap = useMemo(() => {
    return new Map(tatiller.map((t) => [t.tarih, t.tur]));
  }, [tatiller]);

  const daysInMonth = useMemo(() => {
    const first = startOfMonth(year, month);
    const last = endOfMonth(year, month);
    return daterange(toISODate(first), toISODate(last));
  }, [year, month]);

  const personelRows = useMemo(() => {
    const filtered =
      takvimGorunum === "havuz_tumu"
        ? takvimPersonelHavuzu
        : takvimPersonelHavuzu.filter((x) => takvimSeciliIds.includes(x.id));
    const refDate = endOfMonth(year, month);
    return filtered.map((personel) => {
      const toplamHakedilen = cumulativeAnnualEntitlementThroughDate(personel, refDate);
      const yillikKullanilanKumulatif = cumulativeAnnualUsedThroughDate(
        personel,
        refDate,
        izinler,
        tatilMap,
      );
      const kalan = toplamHakedilen - yillikKullanilanKumulatif;
      const buSeneHak = (() => {
        const hire = parseISODate(personel.ise_giris);
        const grant = new Date(year, hire.getMonth(), hire.getDate());
        if (grant.getTime() > refDate.getTime()) return 0;
        return calculateAnnualEntitlementAtGrantDate(personel, grant);
      })();

      return {
        personel,
        buSeneHak,
        kalan,
      };
    });
  }, [
    izinler,
    takvimPersonelHavuzu,
    takvimGorunum,
    takvimSeciliIds,
    tatilMap,
    year,
    month,
  ]);

  function izinOfDay(personelId: string, dayIso: string): Izin | undefined {
    const p = personeller.find((x) => x.id === personelId);
    if (!p || dayIso < p.ise_giris) return undefined;
    return izinler.find((iz) => {
      if (iz.personel_id !== personelId) return false;
      if (iz.bitis < p.ise_giris) return false;
      return dayIso >= iz.baslangic && dayIso <= iz.bitis;
    });
  }

  const izinFormSecimAraligi = useMemo(() => {
    const a = ddMmYyyyToIso(izinForm.baslangic);
    const b = ddMmYyyyToIso(izinForm.bitis);
    if (!a || !b || a > b) return null;
    return { bas: a, bit: b };
  }, [izinForm.baslangic, izinForm.bitis]);

  const mazeretTakvimYilSecenekleri = useMemo(() => {
    const c = bugun.getFullYear();
    const lo = 2009;
    const hi = Math.max(c + 7, mazeretTakvimYil);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }, [mazeretTakvimYil]);

  function mazeretTakvimGunTik(iso: string) {
    if (!mazeretTakvimBirinciGun) {
      setMazeretTakvimBirinciGun(iso);
      const tr = isoToDdMmYyyy(iso);
      setIzinForm((prev) => ({ ...prev, baslangic: tr, bitis: tr }));
      return;
    }
    const u = mazeretTakvimBirinciGun;
    setMazeretTakvimBirinciGun(null);
    const a = u < iso ? u : iso;
    const b = u < iso ? iso : u;
    setIzinForm((prev) => ({
      ...prev,
      baslangic: isoToDdMmYyyy(a),
      bitis: isoToDdMmYyyy(b),
    }));
  }

  function mazeretTakvimMevcutIzin(dayIso: string): Izin | undefined {
    const pid = izinForm.personel_id;
    if (!pid) return undefined;
    const p = personeller.find((x) => x.id === pid);
    if (!p || dayIso < p.ise_giris) return undefined;
    return izinler.find(
      (iz) =>
        iz.personel_id === pid &&
        iz.bitis >= p.ise_giris &&
        dayIso >= iz.baslangic &&
        dayIso <= iz.bitis,
    );
  }

  const seciliIzinPersonel = useMemo(
    () => personeller.find((p) => p.id === izinForm.personel_id) ?? null,
    [personeller, izinForm.personel_id],
  );

  const mazeretAylikOzetMap = useMemo(() => {
    const out = new Map<number, string>();
    if (!seciliIzinPersonel) return out;

    const kodSira: IzinKod[] = ["yillik", "rapor", "dis", "evlilik", "cenaze", "dogum"];
    for (let monthIdx = 0; monthIdx < 12; monthIdx++) {
      const ayBas = toISODate(startOfMonth(mazeretTakvimYil, monthIdx));
      const aySon = toISODate(endOfMonth(mazeretTakvimYil, monthIdx));
      const toplamlar = new Map<IzinKod, number>();

      for (const iz of izinler) {
        if (iz.personel_id !== seciliIzinPersonel.id) continue;
        if (iz.bitis < seciliIzinPersonel.ise_giris) continue;
        if (iz.bitis < ayBas || iz.baslangic > aySon) continue;
        const from = iz.baslangic > ayBas ? iz.baslangic : ayBas;
        const to = iz.bitis < aySon ? iz.bitis : aySon;
        if (from > to) continue;
        const gun = yearlyLeaveCharge(from, to, tatilMap);
        toplamlar.set(iz.izin_tipi, (toplamlar.get(iz.izin_tipi) ?? 0) + gun);
      }

      const ozet = kodSira
        .map((kod) => {
          const v = toplamlar.get(kod) ?? 0;
          if (v <= 0) return "";
          const txt =
            Math.round(v * 10) % 10 === 0 ? String(Math.round(v)) : String(v).replace(".", ",");
          return `${izinKisaltma[kod]}=${txt}`;
        })
        .filter(Boolean)
        .join(", ");
      out.set(monthIdx, ozet || "-");
    }
    return out;
  }, [seciliIzinPersonel, mazeretTakvimYil, izinler, tatilMap]);

  async function handlePersonelInsert(e: FormEvent<HTMLFormElement>) {
    const sb = getSupabaseClient();
    if (!sb) {
      setError("Supabase baglantisi kurulamadi.");
      setSaving(false);
      return;
    }

    e.preventDefault();
    setSaving(true);
    setError("");
    setInfo("");
    const dogumIso = ddMmYyyyToIso(personelForm.dogum_tarihi);
    const iseIso = ddMmYyyyToIso(personelForm.ise_giris);
    const ayrilisTr = personelForm.ayrilis_tarihi.trim();
    const ayrilisIso = ayrilisTr ? ddMmYyyyToIso(ayrilisTr) : null;
    if (!dogumIso || !iseIso) {
      setError("Dogum ve ise giris tarihleri gg.aa.yyyy olarak girilmeli.");
      setSaving(false);
      return;
    }
    if (ayrilisTr && !ayrilisIso) {
      setError("Ayrilis tarihi gg.aa.yyyy olarak girilmeli veya bos birakin.");
      setSaving(false);
      return;
    }
    type PersonelInsert = Database["public"]["Tables"]["personel"]["Insert"];

    const payload: PersonelInsert = {
      ad: personelForm.ad.trim(),
      dogum_tarihi: dogumIso,
      ise_giris: iseIso,
      ayrilis_tarihi: ayrilisIso,
      cinsiyet: personelForm.cinsiyet,
    };
    const { error: insError } = await sb.from("personel").insert(payload);
    if (insError) setError(insError.message);
    else {
      setInfo("Personel eklendi.");
      await loadData();
    }
    setSaving(false);
  }

  async function handlePersonelUpdate() {
    const sb = getSupabaseClient();
    if (!sb) {
      setError("Supabase baglantisi kurulamadi.");
      setSaving(false);
      return;
    }

    if (!selectedPersonelId) return;
    setSaving(true);
    setError("");
    setInfo("");
    const dogumIso = ddMmYyyyToIso(personelForm.dogum_tarihi);
    const iseIso = ddMmYyyyToIso(personelForm.ise_giris);
    const ayrilisTr = personelForm.ayrilis_tarihi.trim();
    const ayrilisIso = ayrilisTr ? ddMmYyyyToIso(ayrilisTr) : null;
    if (!dogumIso || !iseIso) {
      setError("Dogum ve ise giris tarihleri gg.aa.yyyy olarak girilmeli.");
      setSaving(false);
      return;
    }
    if (ayrilisTr && !ayrilisIso) {
      setError("Ayrilis tarihi gg.aa.yyyy olarak girilmeli veya bos birakin.");
      setSaving(false);
      return;
    }
    const payload = {
      ad: personelForm.ad.trim(),
      dogum_tarihi: dogumIso,
      ise_giris: iseIso,
      ayrilis_tarihi: ayrilisIso,
      cinsiyet: personelForm.cinsiyet,
    };
    const { error: updError } = await sb
      .from("personel")
      .update(payload)
      .eq("id", selectedPersonelId);
    if (updError) setError(updError.message);
    else {
      setInfo("Personel guncellendi.");
      await loadData();
    }
    setSaving(false);
  }

  async function handleIzinInsert(e: FormEvent<HTMLFormElement>) {
    const sb = getSupabaseClient();
    if (!sb) {
      setMazeretFormMesaj({
        text: "Supabase baglantisi kurulamadi.",
        tip: "err",
      });
      setSaving(false);
      return;
    }

    e.preventDefault();
    if (!izinForm.personel_id) {
      setMazeretFormMesaj({ text: "Lutfen personel secin.", tip: "err" });
      return;
    }
    if (!izinForm.izin_tipi) {
      setMazeretFormMesaj({ text: "Lutfen mazeret turu secin.", tip: "err" });
      return;
    }
    setSaving(true);
    setMazeretFormMesaj(null);

    const basIso = ddMmYyyyToIso(izinForm.baslangic);
    const bitIso = ddMmYyyyToIso(izinForm.bitis);
    if (!basIso || !bitIso) {
      setMazeretFormMesaj({
        text: "Baslangic ve bitis gg.aa.yyyy olarak girilmeli.",
        tip: "err",
      });
      setSaving(false);
      return;
    }
    if (basIso > bitIso) {
      setMazeretFormMesaj({
        text: "Baslangic tarihi bitisten sonra olamaz.",
        tip: "err",
      });
      setSaving(false);
      return;
    }

    const selectedPersonel = personeller.find((p) => p.id === izinForm.personel_id);
    if (!selectedPersonel) {
      setMazeretFormMesaj({ text: "Personel bulunamadi.", tip: "err" });
      setSaving(false);
      return;
    }

    const kod = izinForm.izin_tipi;
    const gun = yearlyLeaveCharge(basIso, bitIso, tatilMap);

    type IzinInsert = Database["public"]["Tables"]["izinler"]["Insert"];

    const payload: IzinInsert = {
      personel_id: izinForm.personel_id,
      izin_tipi: kod,
      baslangic: basIso,
      bitis: bitIso,
      gun_sayisi: gun,
      gun,
      aciklama: izinForm.aciklama || null,
    };

    const { error: insError } = await sb.from("izinler").insert(payload);
    if (insError) setMazeretFormMesaj({ text: insError.message, tip: "err" });
    else {
      setMazeretFormMesaj({ text: "Kayit eklendi.", tip: "ok" });
      await loadData();
      setIzinForm({
        personel_id: "",
        izin_tipi: "",
        baslangic: "",
        bitis: "",
        aciklama: "",
      });
      setMazeretPersonelArama("");
      setMazeretPersonelListeAcik(false);
      setMazeretTurArama("");
      setMazeretTurListeAcik(false);
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }
    setSaving(false);
  }

  async function handleExcelIzinFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const sb = getSupabaseClient();
    if (!sb) {
      setExcelIzinRaporu({ eklenen: 0, hatalar: ["Supabase baglantisi yok."] });
      return;
    }
    if (!hasSupabaseEnv) {
      setExcelIzinRaporu({ eklenen: 0, hatalar: ["Supabase env tanimli degil."] });
      return;
    }
    if (personeller.length === 0) {
      setExcelIzinRaporu({ eklenen: 0, hatalar: ["Once personel listesi yuklensin."] });
      return;
    }

    setExcelIzinYukleniyor(true);
    setExcelIzinRaporu(null);
    const hatalar: string[] = [];
    let eklenen = 0;
    const maxSatir = 2500;

    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, {
        header: 1,
        defval: "",
        raw: false,
      }) as unknown[][];

      if (rows.length === 0) {
        hatalar.push("Ilk sayfada satir yok.");
      } else {
        let basSatir = 0;
        const i0t1 = ddMmYyyyToIso(
          hucreyiTarihMetnine(rows[0]?.[1] as unknown),
        );
        const i0t2 = ddMmYyyyToIso(
          hucreyiTarihMetnine(rows[0]?.[2] as unknown),
        );
        if (!i0t1 || !i0t2) basSatir = 1;

        const map = tatilMap;

        for (let i = basSatir; i < rows.length && i < maxSatir; i++) {
          const row = rows[i];
          if (!row || row.length === 0) continue;
          const adHam = row[0];
          if (adHam == null || String(adHam).trim() === "") continue;

          const satirNo = i + 1;
          const p = personelBulAdla(personeller, String(adHam));
          if (!p) {
            hatalar.push(
              `Satir ${satirNo}: Personel bulunamadi: "${String(adHam).trim()}"`,
            );
            continue;
          }

          const basTr = hucreyiTarihMetnine(row[1]);
          const bitTr = hucreyiTarihMetnine(row[2]);
          const basIso = ddMmYyyyToIso(basTr);
          const bitIso = ddMmYyyyToIso(bitTr);
          if (!basIso || !bitIso) {
            hatalar.push(
              `Satir ${satirNo}: Gecersiz tarih (B: "${basTr}", C: "${bitTr}")`,
            );
            continue;
          }
          if (basIso > bitIso) {
            hatalar.push(`Satir ${satirNo}: Baslangic bitisten sonra.`);
            continue;
          }

          const kod = turKoduHucreden(row[3], izinTurleri);
          if (kod == null) {
            hatalar.push(
              `Satir ${satirNo}: Bilinmeyen izin turu: "${String(row[3] ?? "").trim()}"`,
            );
            continue;
          }

          const gun = yearlyLeaveCharge(basIso, bitIso, map);

          const payload = {
            personel_id: p.id,
            izin_tipi: kod,
            baslangic: basIso,
            bitis: bitIso,
            gun_sayisi: gun,
            gun,
            aciklama: null as string | null,
          };

          const { error: insErr } = await sb.from("izinler").insert(payload);
          if (insErr) {
            hatalar.push(`Satir ${satirNo}: ${insErr.message}`);
          } else {
            eklenen += 1;
          }
        }

        if (rows.length - basSatir > maxSatir) {
          hatalar.push(`En fazla ${maxSatir} satir islendi; dosyanin geri kani atlandi.`);
        }
      }

      setExcelIzinRaporu({ eklenen, hatalar });
      if (eklenen > 0) await loadData();
    } catch (err) {
      setExcelIzinRaporu({
        eklenen: 0,
        hatalar: [err instanceof Error ? err.message : "Dosya okunamadi."],
      });
    } finally {
      setExcelIzinYukleniyor(false);
    }
  }

  const ayIsimleri = [
    "Ocak",
    "Subat",
    "Mart",
    "Nisan",
    "Mayis",
    "Haziran",
    "Temmuz",
    "Agustos",
    "Eylul",
    "Ekim",
    "Kasim",
    "Aralik",
  ];

  const takvimDosyaAdiKoku = `${ayIsimleri[month]}_${year}`.replace(/\s+/g, "_");

  async function takvimIndirPng() {
    const el = takvimExportRef.current;
    if (!el || personelRows.length === 0) return;
    setTakvimDisariAktariliyor(true);
    setError("");
    try {
      const canvas = await captureTakvimElement(el);
      indirCanvasPng(canvas, `takvim_${takvimDosyaAdiKoku}.png`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "PNG olusturulamadi.");
    } finally {
      setTakvimDisariAktariliyor(false);
    }
  }

  async function takvimIndirPdf() {
    const el = takvimExportRef.current;
    if (!el || personelRows.length === 0) return;
    setTakvimDisariAktariliyor(true);
    setError("");
    try {
      const canvas = await captureTakvimElement(el);
      await indirTakvimPdf(canvas, `takvim_${takvimDosyaAdiKoku}.pdf`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDF olusturulamadi.");
    } finally {
      setTakvimDisariAktariliyor(false);
    }
  }

  async function indirPersonelMazeretEkstresi() {
    if (!selectedPersonelId) return;
    const p = personeller.find((x) => x.id === selectedPersonelId);
    if (!p) return;
    setError("");
    try {
      const XLSX = await import("xlsx");
      const kayitlar = izinler
        .filter((i) => i.personel_id === selectedPersonelId && i.bitis >= p.ise_giris)
        .slice()
        .sort((a, b) => a.baslangic.localeCompare(b.baslangic));
      const baslik = [
        "Mazeret Turu",
        "Baslangic",
        "Bitis",
        "Gun",
        "Aciklama",
      ];
      const satirlar = kayitlar.map((i) => {
        const turAd =
          izinTurleri.find((t) => t.kod === i.izin_tipi)?.ad ?? i.izin_tipi;
        const gun = i.gun ?? i.gun_sayisi ?? "";
        return [
          turAd,
          isoToDdMmYyyy(i.baslangic),
          isoToDdMmYyyy(i.bitis),
          gun,
          i.aciklama ?? "",
        ];
      });
      const yillikKayitlar = kayitlar.filter((i) => i.izin_tipi === "yillik");
      const formatKisaTr = (d: Date) => `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
      const hire = parseISODate(p.ise_giris);
      const ayrilis = p.ayrilis_tarihi ? parseISODate(p.ayrilis_tarihi) : null;
      const sonYillikBitis = yillikKayitlar.reduce<Date | null>((acc, i) => {
        const d = parseISODate(i.bitis);
        if (!acc || d.getTime() > acc.getTime()) return d;
        return acc;
      }, null);
      const bugunRef = new Date();
      const horizonAday = sonYillikBitis && sonYillikBitis.getTime() > bugunRef.getTime()
        ? sonYillikBitis
        : bugunRef;
      const horizon = ayrilis && ayrilis.getTime() < horizonAday.getTime() ? ayrilis : horizonAday;

      const devirKullanilan = Number(p.devir_onceki_kullanilan_izin ?? 0);
      const ozetSatirlari: Array<[string, number | string, number, number]> = [];
      let toplamHak = 0;
      let toplamKullanilan = devirKullanilan;
      let toplamBakiye = -devirKullanilan;
      for (let n = 0; n <= 80; n++) {
        const bas = new Date(hire.getFullYear() + n, hire.getMonth(), hire.getDate());
        if (bas.getTime() > horizon.getTime()) break;
        const sonrakiYil = new Date(hire.getFullYear() + n + 1, hire.getMonth(), hire.getDate());
        const donemSon = new Date(sonrakiYil.getTime() - 86400000);
        const kullanilanDonemSon =
          donemSon.getTime() < horizon.getTime() ? donemSon : horizon;
        const hak = n === 0 ? 0 : calculateAnnualEntitlementAtGrantDate(p, bas);
        let kullanilan = 0;
        if (toISODate(bas) <= toISODate(kullanilanDonemSon)) {
          kullanilan = annualLeaveUsedInIsoRange(
            p,
            toISODate(bas),
            toISODate(kullanilanDonemSon),
            izinler,
            tatilMap,
          );
        }
        const satirBakiye = hak - kullanilan;
        ozetSatirlari.push([formatKisaTr(bas), hak, kullanilan, satirBakiye]);
        toplamHak += hak;
        toplamKullanilan += kullanilan;
        toplamBakiye += satirBakiye;
      }

      const ozetBaslik = ["Yillar", "Hakedilen", "Kullanilan", "Sonraki Yila Devir"];
      const ozetVeri = [
        ["Devir", "", devirKullanilan, -devirKullanilan],
        ...ozetSatirlari.map((r) => [r[0], r[1], r[2], r[3]]),
      ];
      const ws = XLSX.utils.aoa_to_sheet([
        baslik,
        ...satirlar,
        [],
        ["Yillik Izin Ozeti"],
        ozetBaslik,
        ...ozetVeri,
        [],
        ["Toplam", toplamHak, toplamKullanilan, toplamBakiye],
        ["Kullanilmayan Toplam", "", "", toplamBakiye],
      ]);
      ws["!cols"] = [{ wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 40 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Mazeret");
      XLSX.writeFile(wb, `mazeret_ekstresi_${dosyaAdiGuvenli(p.ad)}.xlsx`);
      setInfo(
        kayitlar.length === 0
          ? "Mazeret ekstresi indirildi (henuz kayit yok)."
          : `Mazeret ekstresi: ${kayitlar.length} satir.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Excel olusturulamadi.");
    }
  }

  const seciliPersonelYillikOzet = useMemo(() => {
    if (!selectedPersonelId) return null;
    const p = personeller.find((x) => x.id === selectedPersonelId);
    if (!p) return null;

    const kayitlar = izinler.filter(
      (i) => i.personel_id === selectedPersonelId && i.izin_tipi === "yillik" && i.bitis >= p.ise_giris,
    );
    const hire = parseISODate(p.ise_giris);
    const ayrilis = p.ayrilis_tarihi ? parseISODate(p.ayrilis_tarihi) : null;
    const sonYillikBitis = kayitlar.reduce<Date | null>((acc, i) => {
      const d = parseISODate(i.bitis);
      if (!acc || d.getTime() > acc.getTime()) return d;
      return acc;
    }, null);
    const bugunRef = new Date();
    const horizonAday =
      sonYillikBitis && sonYillikBitis.getTime() > bugunRef.getTime()
        ? sonYillikBitis
        : bugunRef;
    const horizon = ayrilis && ayrilis.getTime() < horizonAday.getTime() ? ayrilis : horizonAday;

    const devirKullanilan = Number(p.devir_onceki_kullanilan_izin ?? 0);
    const rows: Array<{ bas: string; hak: number | string; kullanilan: number; devir: number }> = [];
    let toplamHak = 0;
    let toplamKullanilan = devirKullanilan;
    let toplamBakiye = -devirKullanilan;
    for (let n = 0; n <= 80; n++) {
      const basDate = new Date(hire.getFullYear() + n, hire.getMonth(), hire.getDate());
      if (basDate.getTime() > horizon.getTime()) break;
      const sonrakiYil = new Date(hire.getFullYear() + n + 1, hire.getMonth(), hire.getDate());
      const donemSon = new Date(sonrakiYil.getTime() - 86400000);
      const kullanilanDonemSon = donemSon.getTime() < horizon.getTime() ? donemSon : horizon;
      const basIso = toISODate(basDate);
      const donemSonIso = toISODate(kullanilanDonemSon);
      const hak = n === 0 ? 0 : calculateAnnualEntitlementAtGrantDate(p, basDate);
      let kullanilan = 0;
      if (basIso <= donemSonIso) {
        kullanilan = annualLeaveUsedInIsoRange(
          p,
          basIso,
          donemSonIso,
          izinler,
          tatilMap,
        );
      }
      const satirBakiye = hak - kullanilan;
      rows.push({ bas: isoToDdMmYyyy(basIso), hak, kullanilan, devir: satirBakiye });
      toplamHak += hak;
      toplamKullanilan += kullanilan;
      toplamBakiye += satirBakiye;
    }
    rows.unshift({ bas: "Devir", hak: "", kullanilan: devirKullanilan, devir: -devirKullanilan });
    return { personelAd: p.ad, rows, toplamHak, toplamKullanilan, kullanilmayanToplam: toplamBakiye };
  }, [selectedPersonelId, personeller, izinler, tatilMap]);

  const fieldClass =
    "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
  const labelClass =
    "mb-1 flex h-8 items-end text-xs font-semibold uppercase tracking-wide text-slate-600";
  const mazeretFieldClass =
    "h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-xs shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
  const mazeretLabelClass =
    "mb-0.5 flex h-6 items-end text-[11px] font-semibold uppercase tracking-wide text-slate-600";
  /** Dar ekranda sarilabilir; genis ekranda tek sira (xl+). Sabit minmax yerine esnek sutun. */
  const formGridClass =
    "grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 items-start [&>*]:min-w-0";
  const mazeretFormGridClass =
    "grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 items-start [&>*]:min-w-0";

  return (
    <div className="min-h-screen bg-slate-100 p-4 md:p-8">
      <div className="mx-auto flex w-full min-w-0 max-w-[1500px] flex-col gap-6">
        <h1 className="text-2xl font-semibold">Personel Izin Takip</h1>

        {!hasSupabaseEnv && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
            `NEXT_PUBLIC_SUPABASE_URL` ve `NEXT_PUBLIC_SUPABASE_ANON_KEY` tanimli degil.
          </div>
        )}
        {error && <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-red-800">{error}</div>}
        {info && <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-emerald-800">{info}</div>}
        {loading && <div className="rounded-lg border bg-white p-3">Yukleniyor...</div>}

        <section
          className={`min-w-0 rounded-xl border border-slate-200/90 p-4 shadow-sm transition-[background-color] duration-300 ease-out ${mazeretFormArkaplan[izinForm.izin_tipi || "yillik"]}`}
        >
          <h2 className="mb-2 text-base font-semibold">Mazeret Giris</h2>
          <form onSubmit={handleIzinInsert} className="block">
            <div className={mazeretFormGridClass}>
            <div className="relative z-20" ref={mazeretPersonelKutuRef}>
              <label className={mazeretLabelClass}>Personel (ada gore ara)</label>
              <input
                className={mazeretFieldClass}
                placeholder="Isim yazin, liste suzulur..."
                autoComplete="off"
                value={mazeretPersonelArama}
                onChange={(e) => {
                  const sel = personeller.find((p) => p.id === izinForm.personel_id);
                  const v = sel
                    ? combValueAfterFullSelection(e.target.value, sel.ad, mazeretPersonelArama)
                    : e.target.value;
                  setMazeretPersonelArama(v);
                  setMazeretPersonelListeAcik(true);
                  setIzinForm((prev) => {
                    const pSel = personeller.find((p) => p.id === prev.personel_id);
                    if (pSel && pSel.ad === v) return prev;
                    return { ...prev, personel_id: "" };
                  });
                }}
                onFocus={() => setMazeretPersonelListeAcik(true)}
              />
              {mazeretPersonelListeAcik && (
                <ul className="absolute mt-1 max-h-52 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                  {mazeretPersonelFiltre.length === 0 ? (
                    <li className="px-3 py-2 text-sm text-slate-500">Eslesen personel yok</li>
                  ) : (
                    mazeretPersonelFiltre.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-100 ${
                            izinForm.personel_id === p.id ? "bg-blue-50 font-medium" : ""
                          }`}
                          onMouseDown={(ev) => ev.preventDefault()}
                          onClick={() => {
                            setIzinForm((prev) => ({ ...prev, personel_id: p.id }));
                            setMazeretPersonelArama(p.ad);
                            setMazeretPersonelListeAcik(false);
                          }}
                        >
                          {p.ad}
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>

            <div className="relative z-20" ref={mazeretTurKutuRef}>
              <label className={mazeretLabelClass}>Mazeret Turu (ada gore ara)</label>
              <input
                className={mazeretFieldClass}
                placeholder="Tur adi yazin, liste suzulur..."
                autoComplete="off"
                value={mazeretTurArama}
                onChange={(e) => {
                  const sel = izinTurleri.find((t) => t.kod === izinForm.izin_tipi);
                  const v = sel
                    ? combValueAfterFullSelection(e.target.value, sel.ad, mazeretTurArama)
                    : e.target.value;
                  setMazeretTurArama(v);
                  setMazeretTurListeAcik(true);
                  setIzinForm((prev) => {
                    const tSel = izinTurleri.find((t) => t.kod === prev.izin_tipi);
                    if (tSel && tSel.ad === v) return prev;
                    return { ...prev, izin_tipi: "" };
                  });
                }}
                onFocus={() => setMazeretTurListeAcik(true)}
              />
              {mazeretTurListeAcik && (
                <ul className="absolute mt-1 max-h-52 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                  {mazeretTurFiltre.length === 0 ? (
                    <li className="px-3 py-2 text-sm text-slate-500">Eslesen tur yok</li>
                  ) : (
                    mazeretTurFiltre.map((t) => (
                      <li key={t.kod}>
                        <button
                          type="button"
                          className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-100 ${
                            izinForm.izin_tipi === t.kod ? "bg-blue-50 font-medium" : ""
                          }`}
                          onMouseDown={(ev) => ev.preventDefault()}
                          onClick={() => {
                            setIzinForm((prev) => ({ ...prev, izin_tipi: t.kod }));
                            setMazeretTurArama(t.ad);
                            setMazeretTurListeAcik(false);
                          }}
                        >
                          {t.ad}
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>

            <div>
              <label className={mazeretLabelClass}>Baslangic (gg.aa.yyyy)</label>
              <input
                className={mazeretFieldClass}
                inputMode="numeric"
                placeholder="gg.aa.yyyy veya g-a-yyyy"
                autoComplete="off"
                value={izinForm.baslangic}
                onChange={(e) =>
                  setIzinForm((prev) => ({
                    ...prev,
                    baslangic: maskDateInputFlexible(e.target.value),
                  }))
                }
                required
              />
            </div>
            <div>
              <label className={mazeretLabelClass}>Bitis (gg.aa.yyyy)</label>
              <input
                className={mazeretFieldClass}
                inputMode="numeric"
                placeholder="gg.aa.yyyy veya g-a-yyyy"
                autoComplete="off"
                value={izinForm.bitis}
                onChange={(e) =>
                  setIzinForm((prev) => ({
                    ...prev,
                    bitis: maskDateInputFlexible(e.target.value),
                  }))
                }
                required
              />
            </div>
            <div className="min-w-0 sm:col-span-2 lg:col-span-3 xl:col-span-2">
              <label className={mazeretLabelClass}>Aciklama (Opsiyonel)</label>
              <input
                className={mazeretFieldClass}
                value={izinForm.aciklama}
                onChange={(e) => setIzinForm((prev) => ({ ...prev, aciklama: e.target.value }))}
                placeholder="Orn: Hastane sevki, saha gorevi, vb."
              />
            </div>

            <div className="col-span-full mt-2 min-w-0 rounded-lg border border-slate-200 bg-white/90 p-3 shadow-inner">
              <div className="mb-2 flex min-w-0 flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-xs font-semibold text-slate-800">Yillik takvimden tarih secimi</h3>
                  <p className="text-[11px] leading-relaxed text-slate-600">
                    Ilk tik: tek gun (baslangic = bitis). ikinci tik: aralik. Ucuncu tik yeni araliga baslar.
                    Secilen tur rengi yeni giris araliginda kullanilir. Personel seciliyse mevcut kayitlar kisaltma ile
                    gosterilir.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-[11px] font-semibold text-slate-600">Yil</label>
                  <select
                    className={`${mazeretFieldClass} h-8 w-auto min-w-[5.5rem]`}
                    value={mazeretTakvimYil}
                    onChange={(e) => {
                      setMazeretTakvimYil(Number(e.target.value));
                      setMazeretTakvimBirinciGun(null);
                    }}
                  >
                    {mazeretTakvimYilSecenekleri.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="rounded-md border border-slate-300 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                    onClick={() => {
                      setMazeretTakvimBirinciGun(null);
                      setIzinForm((prev) => ({ ...prev, baslangic: "", bitis: "" }));
                    }}
                  >
                    Tarihleri temizle
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {ayIsimleri.map((ayAd, monthIdx) => {
                  const haftalar = monthWeekGrid(mazeretTakvimYil, monthIdx);
                  const gunBaslik = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
                  const secTip = (izinForm.izin_tipi || "yillik") as IzinKod;
                  const ayOzet = mazeretAylikOzetMap.get(monthIdx) ?? "-";
                  return (
                    <div key={ayAd} className="min-w-0 overflow-hidden rounded-md border border-slate-200">
                      <div className="flex items-center justify-between gap-2 bg-blue-600 px-1.5 py-0.5 text-[11px] text-white">
                        <span className="truncate font-semibold">
                          {ayAd} {mazeretTakvimYil}
                        </span>
                        <span className="truncate text-[10px] font-medium text-blue-100" title={ayOzet}>
                          {ayOzet}
                        </span>
                      </div>
                      <table className="w-full table-fixed border-collapse text-center text-[9px]">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50">
                            <th className="w-6 border-r border-slate-200 py-0.5 font-semibold text-slate-600">
                              Wk
                            </th>
                            {gunBaslik.map((g) => (
                              <th
                                key={g}
                                className={`py-0.5 font-semibold ${
                                  g === "Sa" || g === "Su" ? "text-sky-700" : "text-slate-600"
                                }`}
                              >
                                {g}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {haftalar.map((satir) => (
                            <tr key={`${satir.weekNo}-${monthIdx}-${toISODate(satir.days[0])}`}>
                              <td className="border border-slate-100 bg-slate-50/80 py-0.5 text-[8px] font-medium text-slate-500">
                                {satir.weekNo}
                              </td>
                              {satir.days.map((gunTarih) => {
                                const iso = toISODate(gunTarih);
                                const buAy = gunTarih.getMonth() === monthIdx;
                                const haftaSonu =
                                  gunTarih.getDay() === 0 || gunTarih.getDay() === 6;
                                const tur = tatilMap.get(iso);
                                const resmi = tur === "resmi_tatil";
                                const yarim = isHalfDay(iso, tur);
                                const secimde =
                                  izinFormSecimAraligi != null &&
                                  iso >= izinFormSecimAraligi.bas &&
                                  iso <= izinFormSecimAraligi.bit;
                                const mevcut = mazeretTakvimMevcutIzin(iso);
                                const takvimGunuGecerli =
                                  !isSunday(gunTarih) && tur !== "resmi_tatil";
                                const secimGoster = secimde && takvimGunuGecerli;
                                const mevcutGoster = !!mevcut && takvimGunuGecerli;
                                const mevcutTurAdi = mevcut
                                  ? izinTurleri.find((t) => t.kod === mevcut.izin_tipi)?.ad ?? mevcut.izin_tipi
                                  : "";
                                const seciliTurAdi =
                                  izinTurleri.find((t) => t.kod === secTip)?.ad ?? secTip;
                                const ciroNokta = mazeretTakvimBirinciGun === iso;

                                let zemini: string;
                                if (secimGoster) {
                                  zemini = izinRenk[secTip];
                                } else if (mevcutGoster && buAy && mevcut) {
                                  // Mevcut izin gunleri yalnizca renkle isaretlenir (metin rozeti yok).
                                  zemini = izinRenk[mevcut.izin_tipi];
                                } else if (!buAy) {
                                  zemini = "bg-slate-50/50 text-slate-300";
                                } else if (resmi) {
                                  zemini = "bg-slate-200 text-slate-800";
                                } else if (yarim) {
                                  zemini = "bg-amber-50 text-slate-800";
                                } else if (haftaSonu) {
                                  zemini = "bg-sky-50 text-slate-800";
                                } else {
                                  zemini = "bg-white text-slate-800";
                                }

                                return (
                                  <td key={iso} className="border border-slate-100 p-0 align-middle">
                                    <button
                                      type="button"
                                      disabled={!buAy}
                                      onClick={() => buAy && mazeretTakvimGunTik(iso)}
                                      className={[
                                        "flex h-5 w-full min-w-0 items-center justify-center rounded-sm leading-none",
                                        zemini,
                                        buAy ? "cursor-pointer hover:brightness-95" : "cursor-default opacity-60",
                                        ciroNokta ? "ring-2 ring-amber-500 ring-offset-1" : "",
                                      ].join(" ")}
                                      title={
                                        !buAy
                                          ? ""
                                          : secimGoster
                                            ? `${isoToDdMmYyyy(iso)} — Secim: ${seciliTurAdi}`
                                            : mevcutGoster
                                              ? `${isoToDdMmYyyy(iso)} — Mazeret: ${mevcutTurAdi}`
                                              : `${isoToDdMmYyyy(iso)} — Tikla`
                                      }
                                    >
                                      <span className={buAy ? "font-medium" : ""}>{gunTarih.getDate()}</span>
                                    </button>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>
            </div>

            </div>
            <div className="mt-4 flex min-h-[2.5rem] flex-wrap items-center gap-4">
              <button
                type="submit"
                disabled={saving}
                className="h-10 rounded-lg bg-emerald-600 px-4 py-2 text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-60"
              >
                Kaydi Ekle
              </button>
              {mazeretFormMesaj ? (
                <p
                  role="status"
                  className={`max-w-xl text-sm font-medium ${
                    mazeretFormMesaj.tip === "ok" ? "text-emerald-800" : "text-red-700"
                  }`}
                >
                  {mazeretFormMesaj.text}
                </p>
              ) : null}
            </div>
          </form>

          <div className="mt-8 min-w-0 border-t border-slate-300/70 pt-6">
            <h3 className="mb-1 text-sm font-semibold text-slate-800">
              Excel ile toplu izin aktarimi
            </h3>
            <p className="mb-3 max-w-3xl text-xs leading-relaxed text-slate-600">
              Ilk sayfa kullanilir. A: ad soyad (sistemdekiyle ayrica Turkce kucuk-buyuk harf duyarsiz eslesir),
              B ve C: baslangic / bitis (gg.aa.yyyy, Excel tarih veya seri sayi). D bos = yillik izin; D
              doluysa tur adi (or: Evlilik, Rapor, Disarida Calisma — tablodaki veya bilinen kisa adlar).
              Baslik satiri varsa otomatik atlanir. En fazla 2500 veri satiri.
            </p>
            <input
              ref={excelIzinInputRef}
              type="file"
              accept=".xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              onChange={(ev) => void handleExcelIzinFile(ev)}
            />
            <button
              type="button"
              disabled={excelIzinYukleniyor || loading || !hasSupabaseEnv}
              onClick={() => excelIzinInputRef.current?.click()}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {excelIzinYukleniyor ? "Dosya isleniyor..." : "Excel dosyasi sec (.xls / .xlsx)"}
            </button>
            {excelIzinRaporu ? (
              <div className="mt-4 rounded-lg border border-slate-200 bg-white/80 p-3 text-sm">
                <p
                  className={
                    excelIzinRaporu.hatalar.length === 0
                      ? "font-medium text-emerald-800"
                      : "font-medium text-slate-800"
                  }
                >
                  Aktarilan kayit: {excelIzinRaporu.eklenen}
                  {excelIzinRaporu.hatalar.length > 0
                    ? ` | Uyari / hata: ${excelIzinRaporu.hatalar.length}`
                    : ""}
                </p>
                {excelIzinRaporu.hatalar.length > 0 ? (
                  <ul className="mt-2 max-h-48 list-inside list-disc overflow-y-auto text-xs text-red-700">
                    {excelIzinRaporu.hatalar.map((h, idx) => (
                      <li key={idx}>{h}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>

        <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Aylik Takvim</h2>
              <p className="text-sm text-slate-500">
                Pazar ve resmi tatilde yillik izin rozeti gosterilmez; rapor her zaman gosterilir. Arefe ve
                28 Ekim yarim gun sayilir.
                Sol / sag ok: onceki veya sonraki ay (metin alani veya liste acikken calismaz).
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <span className={labelClass}>Personel listesi</span>
                <select
                  className={`${fieldClass} min-w-[160px]`}
                  value={takvimKaynak}
                  onChange={(e) => setTakvimKaynak(e.target.value as "aktif" | "tumu")}
                >
                  <option value="aktif">Aktif personeller</option>
                  <option value="tumu">Tum personeller</option>
                </select>
              </div>
              <div>
                <span className={labelClass}>Satirlar</span>
                <select
                  className={`${fieldClass} min-w-[180px]`}
                  value={takvimGorunum}
                  onChange={(e) => {
                    const v = e.target.value as "havuz_tumu" | "secili";
                    setTakvimGorunum(v);
                    if (v === "secili") {
                      setTakvimSeciliIds(takvimPersonelHavuzu.map((p) => p.id));
                    }
                  }}
                >
                  <option value="havuz_tumu">Kapsamdaki tumu</option>
                  <option value="secili">Secili personeller</option>
                </select>
              </div>
              <div>
                <span className={labelClass}>Ay</span>
                <select
                  className={`${fieldClass} min-w-[120px]`}
                  value={month}
                  onChange={(e) => setMonth(Number(e.target.value))}
                >
                  {ayIsimleri.map((a, idx) => (
                    <option key={a} value={idx}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <span className={labelClass}>Yil</span>
                <input
                  className={`${fieldClass} w-24`}
                  type="number"
                  value={year}
                  onChange={(e) => setYear(Number(e.target.value))}
                />
              </div>
              <div className="flex flex-col justify-end gap-1">
                <span className={labelClass}>Disa aktar</span>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    disabled={
                      takvimDisariAktariliyor ||
                      personelRows.length === 0 ||
                      (takvimGorunum === "secili" && takvimSeciliIds.length === 0)
                    }
                    onClick={() => void takvimIndirPng()}
                    className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    PNG
                  </button>
                  <button
                    type="button"
                    disabled={
                      takvimDisariAktariliyor ||
                      personelRows.length === 0 ||
                      (takvimGorunum === "secili" && takvimSeciliIds.length === 0)
                    }
                    onClick={() => void takvimIndirPdf()}
                    className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    PDF
                  </button>
                </div>
              </div>
            </div>
          </div>

          {takvimGorunum === "secili" && (
            <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-700">
                  Gosterilecek personelleri secin ({takvimSeciliIds.length} / {takvimPersonelHavuzu.length})
                </span>
                <button
                  type="button"
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-100"
                  onClick={() => setTakvimSeciliIds(takvimPersonelHavuzu.map((p) => p.id))}
                >
                  Tumunu sec
                </button>
                <button
                  type="button"
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-100"
                  onClick={() => setTakvimSeciliIds([])}
                >
                  Temizle
                </button>
              </div>
              <div className="max-h-40 overflow-y-auto rounded border border-slate-200 bg-white p-2 md:grid md:grid-cols-2 md:gap-2 lg:grid-cols-3">
                {takvimPersonelHavuzu.map((p) => (
                  <label
                    key={p.id}
                    className="flex cursor-pointer items-center gap-2 py-1 text-sm hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      className="rounded border-slate-300"
                      checked={takvimSeciliIds.includes(p.id)}
                      onChange={() =>
                        setTakvimSeciliIds((ids) =>
                          ids.includes(p.id) ? ids.filter((x) => x !== p.id) : [...ids, p.id],
                        )
                      }
                    />
                    <span className="truncate">{p.ad}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div
            ref={takvimExportRef}
            className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
          >
            <div className="mb-3 border-b border-slate-100 pb-2">
              <h3 className="text-base font-semibold text-slate-900">
                {ayIsimleri[month]} {year}
              </h3>
              <p className="text-xs text-slate-500">
                Ozet: Aktif / tumu ve satir secimi disa aktarmaya dahil edilir.
              </p>
            </div>

            <div className="mb-3 flex flex-wrap items-stretch gap-2">
              {izinTurleri.map((t) => (
                <span
                  key={t.kod}
                  className={`inline-flex max-w-[11rem] min-w-0 items-center justify-center rounded-full px-2.5 py-1.5 text-center text-[11px] font-medium leading-snug ${izinRenk[t.kod]}`}
                >
                  {t.ad}
                </span>
              ))}
              <span className="inline-flex max-w-[11rem] items-center justify-center rounded-full bg-rose-100 px-2.5 py-1.5 text-center text-[11px] font-medium leading-snug text-slate-800">
                Pazar
              </span>
              <span className="inline-flex max-w-[11rem] items-center justify-center rounded-full bg-slate-200 px-2.5 py-1.5 text-center text-[11px] font-medium leading-snug text-slate-800">
                Resmi Tatil
              </span>
              <span className="inline-flex max-w-[11rem] items-center justify-center rounded-full bg-amber-100 px-2.5 py-1.5 text-center text-[11px] font-medium leading-snug text-slate-800">
                Arefe
              </span>
            </div>

            <div className="w-full max-w-full overflow-x-auto" data-takvim-table-wrap>
            <table className="w-full max-w-full table-fixed border-collapse text-sm">
              <colgroup>
                <col style={{ width: "13rem" }} />
                {daysInMonth.map((d) => (
                  <col key={d} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 border bg-white p-2 text-left shadow-[4px_0_6px_-4px_rgba(0,0,0,0.12)]">
                    Personel
                  </th>
                  {daysInMonth.map((d) => {
                    const date = parseISODate(d);
                    const isPazar = isSunday(date);
                    const tur = tatilMap.get(d);
                    const bg =
                      tur === "resmi_tatil"
                        ? "bg-slate-200"
                        : isHalfDay(d, tur)
                          ? "bg-amber-100"
                          : isPazar
                            ? "bg-rose-100"
                            : "bg-white";
                    return (
                      <th
                        key={d}
                        className={`border p-0.5 text-center text-[10px] font-medium leading-none ${bg}`}
                      >
                        {date.getDate()}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {personelRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={daysInMonth.length + 1}
                      className="border p-6 text-center text-slate-500"
                    >
                      {takvimGorunum === "secili" && takvimSeciliIds.length === 0
                        ? "Secili personel modunda en az bir personel isaretleyin."
                        : "Bu filtrede gosterilecek personel yok."}
                    </td>
                  </tr>
                )}
                {personelRows.map((row) => (
                  <tr key={row.personel.id}>
                    <td className="sticky left-0 z-10 overflow-hidden border bg-white p-1.5 align-top shadow-[4px_0_6px_-4px_rgba(0,0,0,0.12)]">
                      <div className="truncate text-sm font-medium" title={row.personel.ad}>
                        {row.personel.ad}
                      </div>
                      <div className="text-[10px] leading-snug text-slate-500">
                        Bu sene: {row.buSeneHak} | Kalan: {row.kalan}
                      </div>
                      <div className="text-[9px] leading-tight text-slate-400">
                        Ise giris: {isoToDdMmYyyy(row.personel.ise_giris)}
                      </div>
                    </td>
                    {daysInMonth.map((d) => {
                      const date = parseISODate(d);
                      const isPazar = isSunday(date);
                      const tur = tatilMap.get(d);
                      const izin = izinOfDay(row.personel.id, d);
                      /** Rapor gun bazli takvim gunudur; Pazar/resmi tatilde de gosterilir. */
                      const gizleIzin =
                        !!izin &&
                        !shouldShowOnDay(izin, d, tur);
                      const yarimGun = isHalfDay(d, tur);
                      const cellBg =
                        tur === "resmi_tatil"
                          ? "bg-slate-200"
                          : yarimGun
                            ? "bg-amber-100"
                            : isPazar
                              ? "bg-rose-100"
                              : "bg-white";
                      return (
                        <td
                          key={d}
                          className={`h-10 min-w-0 border p-0 align-middle ${cellBg}`}
                        >
                          {izin && !gizleIzin ? (
                            <span
                              className={`box-border flex h-9 w-full min-w-0 items-center justify-center rounded-sm text-xs font-bold leading-none tracking-tight ${izinRenk[izin.izin_tipi]}`}
                              title={`${izin.izin_tipi} (${isoToDdMmYyyy(izin.baslangic)} - ${isoToDdMmYyyy(izin.bitis)})`}
                            >
                              {yarimGun ? `${izinKisaltma[izin.izin_tipi]}½` : izinKisaltma[izin.izin_tipi]}
                            </span>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </section>

        <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold">Personel</h2>
          <div className={formGridClass}>
            <div>
              <label className={labelClass}>Secili Personel</label>
              <select
                className={fieldClass}
                value={selectedPersonelId}
                onChange={(e) => setSelectedPersonelId(e.target.value)}
              >
                <option value="">Personel sec</option>
                {personeller.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.ad}
                  </option>
                ))}
              </select>
            </div>

            {!selectedPersonelId && (
              <div>
                <label className={labelClass}>Ad Soyad</label>
                <input
                  className={fieldClass}
                  placeholder="Orn: Ali Veli"
                  value={personelForm.ad}
                  onChange={(e) => setPersonelForm((prev) => ({ ...prev, ad: e.target.value }))}
                />
              </div>
            )}
            <div>
              <label className={labelClass}>Dogum Tarihi (gg.aa.yyyy)</label>
              <input
                className={fieldClass}
                inputMode="numeric"
                placeholder="gg.aa.yyyy veya g-a-yyyy"
                autoComplete="off"
                value={personelForm.dogum_tarihi}
                onChange={(e) =>
                  setPersonelForm((prev) => ({
                    ...prev,
                    dogum_tarihi: maskDateInputFlexible(e.target.value),
                  }))
                }
              />
            </div>
            <div>
              <label className={labelClass}>Ise Giris Tarihi (gg.aa.yyyy)</label>
              <input
                className={fieldClass}
                inputMode="numeric"
                placeholder="gg.aa.yyyy veya g-a-yyyy"
                autoComplete="off"
                value={personelForm.ise_giris}
                onChange={(e) =>
                  setPersonelForm((prev) => ({
                    ...prev,
                    ise_giris: maskDateInputFlexible(e.target.value),
                  }))
                }
              />
            </div>
            <div>
              <label className={labelClass}>Ayrilis Tarihi (gg.aa.yyyy)</label>
              <input
                className={fieldClass}
                inputMode="numeric"
                placeholder="gg.aa.yyyy veya g-a-yyyy veya bos"
                autoComplete="off"
                value={personelForm.ayrilis_tarihi}
                onChange={(e) =>
                  setPersonelForm((prev) => ({
                    ...prev,
                    ayrilis_tarihi: maskDateInputFlexible(e.target.value),
                  }))
                }
              />
            </div>
            <div>
              <label className={labelClass}>Cinsiyet</label>
              <select
                className={fieldClass}
                value={personelForm.cinsiyet}
                onChange={(e) =>
                  setPersonelForm((prev) => ({ ...prev, cinsiyet: e.target.value as Cinsiyet }))
                }
              >
                <option value="E">Erkek</option>
                <option value="K">Kadin</option>
              </select>
            </div>
          </div>

          {seciliPersonelYillikOzet && (
            <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
              <table className="min-w-[360px] border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50">
                    <th className="border border-slate-200 px-2 py-1 text-left font-semibold">Yillar</th>
                    <th className="border border-slate-200 px-2 py-1 text-right font-semibold">Hakedilen</th>
                    <th className="border border-slate-200 px-2 py-1 text-right font-semibold">Kullanilan</th>
                    <th className="border border-slate-200 px-2 py-1 text-right font-semibold">Sonraki Yila Devir</th>
                  </tr>
                </thead>
                <tbody>
                  {seciliPersonelYillikOzet.rows.map((r) => (
                    <tr key={r.bas}>
                      <td className="border border-slate-200 px-2 py-1">{r.bas}</td>
                      <td className="border border-slate-200 px-2 py-1 text-right">{r.hak}</td>
                      <td className="border border-slate-200 px-2 py-1 text-right">{r.kullanilan}</td>
                      <td className="border border-slate-200 px-2 py-1 text-right">{r.devir}</td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50 font-semibold">
                    <td className="border border-slate-200 px-2 py-1">Toplam</td>
                    <td className="border border-slate-200 px-2 py-1 text-right">
                      {seciliPersonelYillikOzet.toplamHak}
                    </td>
                    <td className="border border-slate-200 px-2 py-1 text-right">
                      {seciliPersonelYillikOzet.toplamKullanilan}
                    </td>
                    <td className="border border-slate-200 px-2 py-1 text-right">
                      {seciliPersonelYillikOzet.kullanilmayanToplam}
                    </td>
                  </tr>
                  <tr className="bg-emerald-50 font-semibold text-emerald-900">
                    <td className="border border-slate-200 px-2 py-1">Kullanilmayan Toplam</td>
                    <td className="border border-slate-200 px-2 py-1 text-right" colSpan={2}>
                      -
                    </td>
                    <td className="border border-slate-200 px-2 py-1 text-right">
                      {seciliPersonelYillikOzet.kullanilmayanToplam}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <form onSubmit={handlePersonelInsert} className="mt-3 flex flex-wrap gap-2">
            <button
              disabled={saving}
              className="rounded-md bg-blue-600 px-4 py-2 text-white disabled:opacity-60"
            >
              Ekle
            </button>
            <button
              type="button"
              onClick={handlePersonelUpdate}
              disabled={saving || !selectedPersonelId}
              className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-60"
            >
              Guncelle
            </button>
            <button
              type="button"
              onClick={() => void indirPersonelMazeretEkstresi()}
              disabled={!selectedPersonelId || loading}
              className="rounded-md border border-emerald-700 bg-white px-4 py-2 text-emerald-900 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Mazeret ekstresi (.xlsx)
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
