'use strict';

async function capturePolicy(pool, venueId) {
  const policy=(await pool.query('SELECT * FROM staff_schedule_venue_policies WHERE venue_id=$1',[venueId])).rows[0]||null;
  const intervals=(await pool.query('SELECT * FROM staff_schedule_venue_business_intervals WHERE venue_id=$1',[venueId])).rows;
  return async function restorePolicy(){
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      if(policy){
        await client.query(`INSERT INTO staff_schedule_venue_policies(venue_id,max_weekly_minutes,minimum_rest_minutes,maximum_consecutive_days,business_hours_enabled,version,created_by,created_at,updated_by,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(venue_id) DO UPDATE SET max_weekly_minutes=EXCLUDED.max_weekly_minutes,minimum_rest_minutes=EXCLUDED.minimum_rest_minutes,maximum_consecutive_days=EXCLUDED.maximum_consecutive_days,business_hours_enabled=EXCLUDED.business_hours_enabled,version=EXCLUDED.version,created_by=EXCLUDED.created_by,created_at=EXCLUDED.created_at,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`,
        [policy.venue_id,policy.max_weekly_minutes,policy.minimum_rest_minutes,policy.maximum_consecutive_days,policy.business_hours_enabled,policy.version,policy.created_by,policy.created_at,policy.updated_by,policy.updated_at]);
      }else await client.query('DELETE FROM staff_schedule_venue_policies WHERE venue_id=$1',[venueId]);
      await client.query('UPDATE staff_schedule_venue_business_intervals SET active=false WHERE venue_id=$1',[venueId]);
      for(const item of intervals)await client.query(`INSERT INTO staff_schedule_venue_business_intervals(id,venue_id,weekday,start_time,end_time,end_day_offset,active,version,created_by,created_at,updated_by,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO UPDATE SET weekday=EXCLUDED.weekday,start_time=EXCLUDED.start_time,end_time=EXCLUDED.end_time,end_day_offset=EXCLUDED.end_day_offset,active=EXCLUDED.active,version=EXCLUDED.version,created_by=EXCLUDED.created_by,created_at=EXCLUDED.created_at,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`,
      [item.id,item.venue_id,item.weekday,item.start_time,item.end_time,item.end_day_offset,item.active,item.version,item.created_by,item.created_at,item.updated_by,item.updated_at]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  };
}

module.exports={capturePolicy};
