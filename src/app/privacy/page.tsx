export const metadata = { title: "Privatlivspolitik / Privacy Policy" };

export default function Privacy() {
  const contact = process.env.CONTACT_EMAIL;
  return (
    <main className="mx-auto max-w-2xl space-y-4 px-6 py-12 text-sm leading-relaxed text-muted">
      <h1 className="text-2xl font-semibold text-fg">Privatlivspolitik</h1>
      <p>Denne tjeneste er et privat værktøj, som ejeren af den forbundne TikTok-konto bruger til at genudgive Twitch-clips fra en kanal, hvor ejeren har tilladelse.</p>
      <p><b className="text-fg">Data vi behandler:</b> OAuth-tokens til TikTok og Twitch (krypteret), offentlige oplysninger om TikTok-profilen (visningsnavn, brugernavn, avatar) og metadata om de clips, der uploades. Vi indsamler ikke data om andre brugere eller seere.</p>
      <p><b className="text-fg">Formål:</b> udelukkende at uploade videoer til den forbundne konto efter kontoejerens samtykke.</p>
      <p><b className="text-fg">Deling:</b> Data deles ikke med tredjeparter ud over TikTok/Twitch API&apos;erne og hostingudbydere (Vercel, Oracle Cloud, Neon).</p>
      <p><b className="text-fg">Sletning:</b> Kontoejeren kan til enhver tid afbryde forbindelsen i dashboardet, hvorved tokens slettes, eller tilbagekalde adgangen i TikTok-appen.</p>
      {contact && <p>Kontakt: <a className="text-accent-2" href={`mailto:${contact}`}>{contact}</a></p>}
      <hr className="border-border" />
      <h2 className="text-lg font-semibold text-fg">Privacy Policy (English)</h2>
      <p>This is a private tool used by the owner of the connected TikTok account to republish Twitch clips they are authorized to use. We store encrypted OAuth tokens, basic public TikTok profile info and clip metadata, solely to upload videos to the connected account with the owner&apos;s consent. No data is sold or shared beyond the TikTok/Twitch APIs and hosting providers. Disconnecting in the dashboard deletes the tokens.</p>
    </main>
  );
}
