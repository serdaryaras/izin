/**
 * Supabase `gen types` ciktisi ile degistirilebilir.
 * Bos dosya build'i kirar; bu minimal tipler CI/Vercel icin yeterlidir.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      personel: {
        Row: {
          id: string;
          ad: string;
          dogum_tarihi: string;
          ise_giris: string;
          ayrilis_tarihi: string | null;
          cinsiyet: string;
          devir_onceki_kullanilan_izin: number | null;
        };
        Insert: {
          id?: string;
          ad: string;
          dogum_tarihi: string;
          ise_giris: string;
          ayrilis_tarihi?: string | null;
          cinsiyet: string;
          devir_onceki_kullanilan_izin?: number | null;
        };
        Update: {
          id?: string;
          ad?: string;
          dogum_tarihi?: string;
          ise_giris?: string;
          ayrilis_tarihi?: string | null;
          cinsiyet?: string;
          devir_onceki_kullanilan_izin?: number | null;
        };
        Relationships: [];
      };
      izinler: {
        Row: {
          id: string;
          personel_id: string;
          izin_tipi: string;
          baslangic: string;
          bitis: string;
          gun_sayisi: number | null;
          gun: number | null;
          aciklama: string | null;
        };
        Insert: {
          id?: string;
          personel_id: string;
          izin_tipi: string;
          baslangic: string;
          bitis: string;
          gun_sayisi?: number | null;
          gun?: number | null;
          aciklama?: string | null;
        };
        Update: {
          id?: string;
          personel_id?: string;
          izin_tipi?: string;
          baslangic?: string;
          bitis?: string;
          gun_sayisi?: number | null;
          gun?: number | null;
          aciklama?: string | null;
        };
        Relationships: [];
      };
      izin_turleri: {
        Row: {
          kod: string;
          ad: string;
          yillik_izinden_duser: boolean;
          varsayilan_hak_gun: number | null;
          cinsiyet_bagli: boolean;
        };
        Insert: {
          kod: string;
          ad: string;
          yillik_izinden_duser?: boolean;
          varsayilan_hak_gun?: number | null;
          cinsiyet_bagli?: boolean;
        };
        Update: {
          kod?: string;
          ad?: string;
          yillik_izinden_duser?: boolean;
          varsayilan_hak_gun?: number | null;
          cinsiyet_bagli?: boolean;
        };
        Relationships: [];
      };
      resmi_tatil_gunleri: {
        Row: {
          tarih: string;
          tur: string;
        };
        Insert: {
          tarih: string;
          tur: string;
        };
        Update: {
          tarih?: string;
          tur?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
