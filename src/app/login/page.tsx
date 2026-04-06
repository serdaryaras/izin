import LoginForm from "./login-form";

type LoginPageProps = {
  searchParams?: Promise<{ next?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = searchParams ? await searchParams : undefined;
  const rawNext = params?.next ?? "/";
  const next = rawNext.startsWith("/") ? rawNext : "/";

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <section className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Giris</h1>
        <p className="mt-1 text-sm text-slate-600">
          Devam etmek icin sifre girin.
        </p>
        <LoginForm nextPath={next} />
      </section>
    </main>
  );
}
