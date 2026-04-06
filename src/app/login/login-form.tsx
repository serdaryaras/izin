"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type LoginFormProps = {
  nextPath: string;
};

export default function LoginForm({ nextPath }: LoginFormProps) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        setError(data?.message || "Giris basarisiz.");
        setLoading(false);
        return;
      }
      router.replace(nextPath);
      router.refresh();
    } catch {
      setError("Giris sirasinda hata olustu.");
      setLoading(false);
    }
  }

  return (
    <form className="mt-5 space-y-3" onSubmit={handleSubmit}>
      <label className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
        Sifre
      </label>
      <input
        type="password"
        autoFocus
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="h-10 w-full rounded-lg border border-slate-300 px-3 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        placeholder="Sifre"
      />
      {error ? (
        <p className="text-sm font-medium text-red-700">{error}</p>
      ) : null}
      <button
        type="submit"
        disabled={loading}
        className="h-10 w-full rounded-lg bg-blue-600 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-60"
      >
        {loading ? "Kontrol ediliyor..." : "Giris Yap"}
      </button>
    </form>
  );
}
