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
          created_at: string | null;
          devir_onceki_kullanilan_izin: number | null;
        };
        Insert: {
          id?: string;
          ad: string;
          dogum_tarihi: string;
          ise_giris: string;
          ayrilis_tarihi?: string | null;
          cinsiyet: string;
          created_at?: string | null;
          devir_onceki_kullanilan_izin?: number | null;
        };
        Update: {
          id?: string;
          ad?: string;
          dogum_tarihi?: string;
          ise_giris?: string;
          ayrilis_tarihi?: string | null;
          cinsiyet?: string;
          created_at?: string | null;
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
          created_at: string | null;
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
          created_at?: string | null;
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
          created_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "izinler_personel_id_fkey";
            columns: ["personel_id"];
            isOneToOne: false;
            referencedRelation: "personel";
            referencedColumns: ["id"];
          }
        ];
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
    Views: {};
    Functions: {};
    Enums: {};
    CompositeTypes: {};
  };
};