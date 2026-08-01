import PairGate from '@/components/PairGate';

export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <div className="shell">
      <header className="top">
        <div>
          <div className="wordmark" aria-label="ОБА">
            <span className="l1" aria-hidden="true">ОБА</span>
            <span className="l2" aria-hidden="true">ОБА</span>
            <span className="l3">ОБА</span>
          </div>
          <p className="tagline">
            Синий — один.
            <br />
            Розовый — второй.
            <br />
            Фиолетовый — общее.
          </p>
        </div>
      </header>

      <PairGate />
    </div>
  );
}
