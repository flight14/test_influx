module.exports = {
  'lt_dock': {
    ra_above: 12,
    ag_above: 10,
    ga_below: 0,
    ar_below: -2,
  },
  'freezer': {
    ra_above: -16,
    ag_above: -18,
    ga_below: -20,
    ar_below: -22,
  },
  'coolroom': {
    ra_above: 7,
    ag_above: 5,
    ga_below: 0,
    ar_below: -2,
  },
  'dry_wh': {
    ra_above: 40,
    ag_above: 38,
    ga_below: 2,
    ar_below: 0,
  },
  'dry_dock_co': {
    ra_above: 20,
    ag_above: 20,
    ga_below: 0,
    ar_below: 0,
  },
  'normalroom': {
    ra_above: 22,
    ag_above: 20,
    ga_below: 0,
    ar_below: -2,
  },
  'controller': {
    src: 'read', // 从数据源读取
    measure: 'offline',
    standard: '持续60分钟或者>6次/天',
    reset_alarm: true,
  },
};