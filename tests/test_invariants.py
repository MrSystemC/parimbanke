"""Run with python tests/test_invariants.py. Exercises actual production SQL migrations."""
import pathlib, sqlite3, tempfile, unittest, threading
ROOT=pathlib.Path(__file__).resolve().parents[1]
BUY="""INSERT INTO purchases (id,request_id,user_id,event_id,quantity,draw_number,created_at)
SELECT ?,?,?,?,?,?,1000 WHERE NOT EXISTS(SELECT 1 FROM purchases WHERE user_id=? AND request_id=?)"""

class EconomicInvariants(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=str(pathlib.Path(self.tmp.name)/'test.sqlite')
        self.db=sqlite3.connect(self.path,isolation_level=None)
        self.db.execute('PRAGMA foreign_keys=ON')
        for path in sorted((ROOT/'drizzle').glob('*.sql')): self.db.executescript(path.read_text())
        for id in ('admin','alice','bob'):
            self.db.execute('INSERT INTO users(id,name,balance,created_at) VALUES (?,?,1000,0)',(id,id))
        self.db.execute("INSERT INTO app_meta VALUES ('admin_user_id','admin')")
        self.event('e',2)
    def tearDown(self): self.db.close(); self.tmp.cleanup()
    def event(self,id,total,start=0):
        self.db.execute("INSERT INTO events(id,title,subtitle,region,city,category,image_key,total_tickets,ticket_price,starts_at,created_at,is_demo) VALUES (?, 'Prize','Description','Region','City','Электроника','speaker',?,100,?,0,0)",(id,total,start))
    def buy(self,user,qty=1,req='request-1',draw=1,event='e',db=None):
        (db or self.db).execute(BUY,(user+req,req,user,event,qty,draw,user,req))
    def value(self,sql,args=()): return self.db.execute(sql,args).fetchone()[0]
    def test_insufficient_balance_rolls_back_everything(self):
        self.db.execute("UPDATE users SET balance=99 WHERE id='alice'")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'INSUFFICIENT_BALANCE'): self.buy('alice')
        self.assertEqual(self.value("SELECT balance FROM users WHERE id='alice'"),99)
        for table in ('tickets','purchases','ledger','notifications'): self.assertEqual(self.value('SELECT count(*) FROM '+table),0)
    def test_unique_ticket_and_atomic_final_draw(self):
        self.buy('alice',draw=1); self.buy('bob',draw=2)
        self.assertEqual(self.db.execute("SELECT status,winner_ticket,winner_user_id,sold_tickets FROM events WHERE id='e'").fetchone(),('completed',2,'bob',2))
        self.assertEqual(self.value("SELECT balance FROM users WHERE id='alice'"),900)
        self.assertEqual(self.value("SELECT balance FROM users WHERE id='bob'"),900)
        self.assertEqual(self.value("SELECT count(*) FROM notifications WHERE id LIKE 'draw:%'"),2)
        with self.assertRaisesRegex(sqlite3.IntegrityError,'EVENT_UNAVAILABLE'): self.buy('alice',req='another-request')
        self.assertEqual(self.value('SELECT count(*) FROM tickets'),2)
    def test_overselling_and_zero_quantity_are_rejected(self):
        self.buy('alice')
        with self.assertRaisesRegex(sqlite3.IntegrityError,'NOT_ENOUGH_TICKETS'): self.buy('bob',qty=2)
        self.assertEqual(self.value("SELECT balance FROM users WHERE id='bob'"),1000)
        with self.assertRaises(sqlite3.IntegrityError): self.buy('bob',qty=0)
        self.assertEqual(self.value('SELECT count(*) FROM tickets'),1)
    def test_retry_does_not_debit_twice(self):
        self.buy('alice'); self.buy('alice')
        self.assertEqual(self.value('SELECT count(*) FROM purchases'),1)
        self.assertEqual(self.value('SELECT count(*) FROM tickets'),1)
        self.assertEqual(self.value("SELECT balance FROM users WHERE id='alice'"),900)
    def test_future_event_is_unavailable(self):
        self.event('future',10,9999999999999)
        with self.assertRaisesRegex(sqlite3.IntegrityError,'EVENT_UNAVAILABLE'): self.buy('alice',event='future')
    def test_admin_credit_once_and_denies_other_actor(self):
        self.db.execute("INSERT INTO coin_requests(id,user_id,amount,message,created_at) VALUES('r','alice',500,'please',0)")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'NOT_ADMIN'):
            self.db.execute("UPDATE coin_requests SET status='approved',reviewed_by='bob',reviewed_at=1 WHERE id='r'")
        self.assertEqual(self.value("SELECT balance FROM users WHERE id='alice'"),1000)
        self.db.execute("UPDATE coin_requests SET status='approved',reviewed_by='admin',reviewed_at=1 WHERE id='r' AND status='pending'")
        self.db.execute("UPDATE coin_requests SET status='approved',reviewed_by='admin',reviewed_at=2 WHERE id='r' AND status='pending'")
        self.assertEqual(self.value("SELECT balance FROM users WHERE id='alice'"),1500)
        self.assertEqual(self.value('SELECT count(*) FROM ledger'),1)
        with self.assertRaisesRegex(sqlite3.IntegrityError,'INVALID_REQUEST_REVIEW'):
            self.db.execute("UPDATE coin_requests SET status='pending' WHERE id='r'")
    def test_rejection_does_not_credit(self):
        self.db.execute("INSERT INTO coin_requests(id,user_id,amount,message,created_at) VALUES('r','alice',500,'please',0)")
        self.db.execute("UPDATE coin_requests SET status='rejected',reviewed_by='admin',reviewed_at=1 WHERE id='r'")
        self.assertEqual(self.value("SELECT balance FROM users WHERE id='alice'"),1000)
        self.assertEqual(self.value('SELECT count(*) FROM ledger'),0)
        self.assertEqual(self.value('SELECT count(*) FROM notifications'),1)
    def test_last_ticket_concurrent_attempts(self):
        self.buy('admin')
        barrier=threading.Barrier(2); results=[]
        def attempt(user):
            db=sqlite3.connect(self.path,timeout=5,isolation_level=None)
            db.execute('PRAGMA foreign_keys=ON'); barrier.wait()
            try: self.buy(user,draw=2,db=db); results.append('ok')
            except sqlite3.IntegrityError: results.append('rejected')
            finally: db.close()
        threads=[threading.Thread(target=attempt,args=(u,)) for u in ('alice','bob')]
        [t.start() for t in threads]; [t.join() for t in threads]
        self.assertCountEqual(results,['ok','rejected'])
        self.assertEqual(self.value('SELECT count(*) FROM tickets'),2)
        self.assertEqual(self.value("SELECT count(*) FROM users WHERE id IN ('alice','bob') AND balance=900"),1)
        self.assertEqual(self.value("SELECT count(*) FROM notifications WHERE id LIKE 'draw:%'"),2)

if __name__=='__main__': unittest.main(verbosity=2)
