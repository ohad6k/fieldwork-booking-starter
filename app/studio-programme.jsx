import { scheduleLabel, timeLabel } from '../lib/programme.mjs';
import { Icon, Mark } from './studio-icons';

function SeatLabel({ state }) {
  return (
    <span className={'seat-label' + (state.open ? '' : ' closed')}>
      <i aria-hidden="true" />
      {state.label}
    </span>
  );
}

export function StudioHeader({ ticketCount, onTickets }) {
  return (
    <header className="topbar">
      <div className="wrap bar-inner">
        <a href="#top" className="brand" aria-label="Fieldwork Studio home">
          <Mark />
          Fieldwork<span className="brand-studio">Studio</span>
        </a>
        <nav aria-label="Main">
          <a href="#programme" className="workshop-link">
            Workshops
          </a>
          <button
            className="tickets-nav"
            aria-label={
              ticketCount
                ? 'My tickets, ' +
                  ticketCount +
                  (ticketCount === 1 ? ' ticket' : ' tickets')
                : 'My tickets'
            }
            onClick={onTickets}
          >
            <Icon name="ticket" />
            My tickets
            {ticketCount > 0 && (
              <span className="ticket-count" aria-hidden="true">
                {ticketCount}
              </span>
            )}
          </button>
        </nav>
      </div>
    </header>
  );
}

export function FeaturedWorkshop({ featured, seatState, action }) {
  return (
    <section className="hero" aria-labelledby="featured-title">
      <div className="hero-copy">
        <p className="eyebrow">
          <span className="short-line" />
          Featured workshop
        </p>
        <h1 id="featured-title">{featured.title}</h1>
        <p className="lead">{featured.summary || featured.description}</p>
        <div className="session-line">
          <span>{featured.discipline} studio</span>
          <span>
            <Icon name="clock" />
            {featured.duration} min
          </span>
        </div>
        <div className="action-line">
          {action}
          <SeatLabel state={seatState} />
        </div>
      </div>
      <figure className="cover">
        <img
          className="cover-art"
          src={'/studies/' + featured.slug + '.webp'}
          alt={featured.alt}
          width="1280"
          height="880"
          fetchPriority="high"
        />
        <figcaption>
          <span>Study {featured.number}</span>
          <span>{featured.technique}</span>
        </figcaption>
      </figure>
    </section>
  );
}

export function WorkshopRow({
  workshop: w,
  session,
  seatState,
  action,
  onChoose,
}) {
  return (
    <article className="row">
      <img
        src={'/studies/' + w.slug + '.webp'}
        srcSet={`/studies/thumbs/${w.slug}-96.webp 96w, /studies/thumbs/${w.slug}-192.webp 192w`}
        sizes="(max-width: 700px) 64px, (max-width: 959px) 76px, 92px"
        onError={(e) => e.currentTarget.removeAttribute('srcset')}
        alt=""
        width="92"
        height="65"
        loading="lazy"
      />
      <div className="row-name">
        <p className="discipline">{w.discipline}</p>
        <h3>
          {session ? (
            <button onClick={() => onChoose(session)}>{w.title}</button>
          ) : (
            w.title
          )}
        </h3>
      </div>
      <div className="row-time">
        {session && (
          <>
            <strong>{scheduleLabel(session.starts_at, 'short')}</strong>
            <span>
              {timeLabel(session.starts_at)} · {w.duration} min
            </span>
          </>
        )}
      </div>
      <SeatLabel state={seatState} />
      {action}
    </article>
  );
}
