import { useNavigate } from 'react-router-dom';
import { useOffers } from './useOffers';

/** "Offers" in the Agreements header, only for a director, the company account or the named offeree. */
const OffersLink = () => {
  const navigate = useNavigate();
  const o = useOffers();
  if (!o.visible) return null;
  const waiting = o.records.filter((r) => r.offer?.offereeKey === o.me && !r.accepted).length;
  return (
    <button type="button" className="ag-btn" onClick={() => navigate('/m/bmail/offers')}>
      Offers{waiting ? ` (${waiting})` : ''}
    </button>
  );
};

export default OffersLink;
