

const Influx = require('influx')
const express = require('express')
const http = require('http')
const os = require('os')
const path = require('path');
const bodyParser = require('body-parser');
const request = require('request');


const app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(bodyParser.urlencoded({    
  extended: false
}));

const influx = new Influx.InfluxDB({
  database: 'flux_yum',
  protocol: 'https',
  host: 'awsflux01.base.li',
  port: 18086,
  username: 'impact',
  password: 'BNMghj!'
});
//console.log('Create influx:', influx);

// setup mysql
const mysql = require('mysql');
const pool  = mysql.createPool({
  connectionLimit : 10,
  host            : 'localhost',
  user            : 'fire_alarm',
  password        : 'fire_alarm',
  database        : 'fire_alarm'
});

http.createServer(app).listen(3100, function () {
  console.log('Listening on port 3100')
})

Date.prototype.addHours = function(h) {    
 this.setTime(this.getTime() + (h*60*60*1000)); 
 return this;   
}

// 对Date的扩展，将 Date 转化为指定格式的String 
// 月(M)、日(d)、小时(h)、分(m)、秒(s)、季度(q) 可以用 1-2 个占位符， 
// 年(y)可以用 1-4 个占位符，毫秒(S)只能用 1 个占位符(是 1-3 位的数字) 
// 例子： 
// (new Date()).formatTime("yyyy-MM-dd hh:mm:ss.S") ==> 2006-07-02 08:09:04.423 
// (new Date()).formatTime("yyyy-M-d h:m:s.S")      ==> 2006-7-2 8:9:4.18 
Date.prototype.formatTime = function (fmt) { //author: meizz 
  var o = {
      "M+": this.getMonth() + 1, //月份 
      "d+": this.getDate(), //日 
      "h+": this.getHours(), //小时 
      "m+": this.getMinutes(), //分 
      "s+": this.getSeconds(), //秒 
      "q+": Math.floor((this.getMonth() + 3) / 3), //季度 
      "S": this.getMilliseconds() //毫秒 
  };
  if (/(y+)/.test(fmt)) 
    fmt = fmt.replace(RegExp.$1, (this.getFullYear() + "").substr(4 - RegExp.$1.length));
  for (var k in o)
    if (new RegExp("(" + k + ")").test(fmt)) 
      fmt = fmt.replace(RegExp.$1, (RegExp.$1.length == 1) ? (o[k]) : (("00" + o[k]).substr(("" + o[k]).length)));
  return fmt;
} 

function groupBy(xs, key) {
  return xs.reduce(function(rv, x) {
    (rv[x[key]] = rv[x[key]] || []).push(x);
    return rv;
  }, {});
};

function minOffsetNow(date) {
  date = date || new Date();
  return parseInt((new Date().getTime() - date.getTime())/(60*1000));
}


/**
 * 全局数据定义
 */
var kpis = require('./kpis');
var sensors = require('./sensors');
var users = require('./users');
var timer = 0;
var out_value = 0;
var out_date = 0;
var tm_off_count = {};

const INTV_MIN = 5;      // 查询间隔 min 
const MIN_SECS = 2;      // 测试时可调到 2 默认 60
const ALM_AFTER = 5;     // 累积多久时长后报警 min
const ALM_BETWEEN = 30;  // 多次报警时长间隔 min
const ALARM_LEVEL = 1;   // 什么等级开始报警, 默认1
const BLOCK_FILE = './blocks.json';
// const WX_MSG_URL = 'http://localhost:3100/blockme';
const WX_MSG_URL = 'http://2whzur.natappfree.cc/blockme';
const KPI_SERVICE = 'http://localhost:3119/kpi/alarm';

/**
 * 获取库名
 */
function groupName(group) {
  switch(group) {
    case 'sydc1':
      return '一号库';
    case 'sydc2':
      return '二号库';
    default:
      return group;
  }
}

/**
 * 解析 tag_mesa 为查询参数
 */
function parseTagMesa (tag_mesa) {
  let measurement = '';
  let mesa_where = '';
  let mesa_vals = '';
  let m = {}, m2 = {};
  let qarray = [];
  
  let chunks = tag_mesa.split(',');
  chunks.forEach((val, key, arr) => {
    let c = val.split('=');
    m[ c[0] ] = c[1];
  });
  m2 = Object.assign({}, m);
  
  if( 'measurement' in m) {
    measurement = `"${m['measurement']}"`;
    delete m.measurement;
  }
  
  for( let k in m) {
    qarray.push( `"${k}"='${m[k]}'`);
  }
  mesa_where = qarray.join(' AND ');
  
  return {
    measurement,
    mesa_where,
    mesa_vals: m2
  };
}

/**
 * 微信 API 初始化
 */
let appId = "wx32e64b2b2f8f20df"; // bstwo 
let appSecret = "905848f29979a4859d2468f76626aa88";
var WechatAPI = require('wechat-api')
var fs = require('fs')
var wechatApi = new WechatAPI(appId, appSecret, function (callback) {
  fs.readFile('access_token.txt', 'utf8', function (err, txt) {
    if (err) {return callback(null, null)} 
    callback(null, JSON.parse(txt))
  })
}, function (token, callback) {
  fs.writeFile('access_token.txt', JSON.stringify(token), callback)
})


/**
 * 开启定时器
 */
function startTimer(res) {
  let pp = '';
  if( timer) {
    pp = 'Error: please stop previous timer.';
    res? res.send(pp): console.err(pp);
  }
  else {
    pp = 'Timer start @'+ INTV_MIN + ' min';
    timer = setInterval(checkSensors, INTV_MIN* 1000* MIN_SECS /*60*/);
    console.log(pp);
    res? res.send(pp): null;
    // At first
    checkSensors();
  }
}

/**
 * 结束定时器
 */
function stopTimer(res) {
  if( timer) {
    clearInterval(timer); timer = 0;
    res? res.send('Timer stop.'): null;
  }
  else {
    res? res.send('No timer.'): null;
  }
}

/**
 * 自动启动首次(分钟需5的倍数)
 */
function autoStart(enable) {
  if(enable) {
    let m1 = new Date().getMinutes();
    let m2 = Math.ceil(m1/5)*5;
    let df = (m2-m1)*1000* MIN_SECS;
    console.log('AutoStart waits:', m2-m1, 'min to start.');
    if(!timer) {
      setTimeout(startTimer, df); 
    }
    else {
      console.log('Error: please stop previous timer.');
    }
  }
}
autoStart(MIN_SECS == 60);

/**
 * 传感器检查流程
 */
function checkSensors() {
  console.log('------ CheckSensors start '+ new Date().toLocaleString()+ '-------');
  
  // 找出在线传感器
  let onlines = sensors.filter(function(s) {
    return !s.offline;
  });

  // 批量查询传感器
  sensorBatchValues(onlines, function(err, sensors) {
    if(err) {  return; }
    
    let blocks = JSON.parse(fs.readFileSync(BLOCK_FILE));
    
    sensors.forEach( function(sensor) {
      let pt = sensor.point, kpi = kpis[sensor.kpi];
      let ck = checkKpi(pt, kpi);
      let ex = exceedCount(sensor, ck);
      if( ex) {
        sendAlarm(sensor, ck, users, blocks);
      }
      console.log(sensor.name+':', ck.value, 'min-off:', sensor.point.min_off, 
        ck.exceed? 'exceed:'+ck.exceed+ ' count: ' +sensor.exc_count[ck.level] : '');
    });
    
    alarmTmOfflineSensors(sensors, users, blocks);
  });  

}

/**
 * 读取传感器值(批量)  
 */
function sensorBatchValues(sensors, callback) {
  let qs = [];
  sensors.forEach( function(sensor) {
    let m = parseTagMesa(sensor.tag_mesa);
    qs.push(`SELECT last(value) FROM ${m.measurement} WHERE ${m.mesa_where}`)
  });
  let q = qs.join('; ');
  //console.log('batch q:', q);
  
  influx.query(q).then(result => {
    // 注: 结果实际不符合 json 格式, 可用 stringify 转
    //console.log('result', JSON.stringify(result)); 
    
    if( sensors.length == 1) {
      result = [result]; // 一个传感器时,必须包装成二维
    }
    
    sensors.forEach( function(sensor, idx) {
      if(sensor.test) {
        sensor.point = {
          time: out_date==0? new Date(): new Date(out_date),
          last: out_value,
        }
      }
      else {
        sensor.point = (result&&result.length>idx&&result[idx].length>0)
          ? result[idx][0]: {};
      }
    });
    callback(null, sensors);
  }).catch(err => {
    console.error('sensorBatchValues err:', err);
    callback(err);
  });
}

/**
 * 读取传感器值(单次)
 */
function sensorValue(sensor, callback) {
  let m = parseTagMesa(sensor.tag_mesa);
  let q = `SELECT last(value) FROM ${m.measurement} WHERE ${m.mesa_where}`;
  //console.log('q:', q);
  
  influx.query(q).then(result => {
    callback(null, (result&&result.length>0)? result[0]: {});
  }).catch(err => {
    console.error('SensorValue err:', err);
    callback(err);
  });
}

/**
 * 计算 KPI
 */
function checkKpi(point, kpi) {
  let ck = {
    src: kpi.src || 'calc',
    measure: kpi.measure || 'temp',
    reset_alarm: kpi.reset_alarm,
    exceed: 0,
    level: 0,
    standard: '',
    is_reset: false,
  };
  
  //TODO: 来自 point 的其他值
  let value = point.last;
  let time = new Date(point.time.getTime());
  //console.log('time', time.toLocaleString());
  
  point.min_off = minOffsetNow(time);
  ck.tm_offline = point.min_off > 12;
  
  if( !kpi.src && !ck.tm_offline) {
    if( kpi.ra_above && value > kpi.ra_above) {
      ck.exceed = 2;
      ck.standard = kpi.ar_below+ '~'+ kpi.ra_above;
    }
    else if( kpi.ag_above && value > kpi.ag_above) {
      ck.exceed = 1;
      ck.standard = kpi.ga_below+ '~'+ kpi.ag_above;
    }
    else if( kpi.ar_below && value < kpi.ar_below) {
      ck.exceed = -2;
      ck.standard = kpi.ar_below+ '~'+ kpi.ra_above;
    }
    else if( kpi.ga_below && value < kpi.ga_below) {
      ck.exceed = -1;
      ck.standard = kpi.ga_below+ '~'+ kpi.ag_above;
    }
  }
  else if( kpi.src == 'read'  && !ck.tm_offline) {
    ck.exceed = value>0? 2: 0;
    ck.standard = kpi.standard;
  }
  
  ck.level = Math.abs(ck.exceed);
  ck.value = value;
  ck.time = time;
  
  return ck;
}

/**
 * 统计超限次数
 *
 * @return true/false 是否累积到报警程度 
 */
function exceedCount(sensor, check) {
  let lvl = check.level;
  sensor.exc_count = sensor.exc_count || {};
  sensor.exc_count[lvl] = sensor.exc_count[lvl] || 0;
  sensor.tm_offline = check.tm_offline;
  
  if(sensor.tm_offline) {
    return false;  // tm_offline 数量太多, 1.不单独报警; 2.不累积计数
  }
  
  if( sensor.exc_count[lvl] == 0 && check.exceed == 0) {
    return false;
  }
  // 0 0
  // 1 1
  
  // 累加计数
  if(check.exceed == 0 || check.level >= ALARM_LEVEL) {
    for(let lo=1; lo<=lvl; lo++)
      sensor.exc_count[lo]++;
    setDuration(check, sensor.exc_count[lvl]);
  }
  else {
    return false; //不计数
  }
  
  if( check.exceed == 0) {
    // 复位情况:也允许发送报警 
    check.is_reset = (sensor.exc_count[lvl] > 1);
    for(let lo=1; lo<=lvl; lo++)
      sensor.exc_count[lo] = 0;
    return ( check.is_reset && check.reset_alarm)? true: false;
  }
  else {
    // 超限情况:从计数判断
    let tms_a = (check.src=='read')? 0: parseInt(ALM_AFTER / INTV_MIN); // ALM_AFTER 转为次数, read 的不用等待 
    let tms_b = parseInt(ALM_BETWEEN / INTV_MIN) || 6;
    let real_tms = sensor.exc_count[lvl]-1; // 因为上面 ALM_AFTER 是累积, 所以 exc_count-1 再判断
    
    if(real_tms < tms_a) {
      return false;
    }
    else {
      real_tms -= tms_a;
      return (real_tms%tms_b == 0)? true: false;
    }
  }
  
  
  /*
  if( check.exceed === 0 || check.level < ALARM_LEVEL) {
    check.is_reset = (sensor.exc_count > 0);
    setDuration(check, sensor.exc_count);
    
    sensor.exc_count = 0;
    
    // 复位也允许发送报警
    return ( check.is_reset && check.reset_alarm)? true: false;
  }
  else {
    // 累加计数
    if(!sensor.exc_count) {
      sensor.exc_count = 1;
    }
    else {
      sensor.exc_count++;
    }
    
    setDuration(check, sensor.exc_count);
    
    // 计数判断
    let tms_a = parseInt(ALM_AFTER / INTV_MIN);
    let tms_b = parseInt(ALM_BETWEEN / INTV_MIN) || 2;
    let real_tms = sensor.exc_count-1; // 因为上面 ALM_AFTER 是累积, 所以 exc_count-1 再判断
    
    if(real_tms < tms_a) {
      return false;
    }
    else {
      real_tms -= tms_a;
      return (real_tms%tms_b == 0)? true: false;
    }
  }
  */ 
}

/**
 * 计算 或 设置时长 
 */
function setDuration(check, exc_count) {
  exc_count = exc_count || 0;
  if(check.src == 'read') {
    check.duration = (exc_count<1)? 0: (exc_count-1)*INTV_MIN;
  }
  else {
    check.duration = (exc_count<2)? 0: (exc_count-2)*INTV_MIN; // -2:隐含减去用于确认的第一个 ALM_AFTER 分钟
  }
  //TODO: read 时,来自 point
}

/**
 * 格式化下时长 
 */
function formatDuration(minutes) {
  minutes = minutes || 0;
  if(minutes < 120 ) {
    return minutes+ '分钟';
  }
  else {
    let hr = parseInt(minutes/60);
    let min = minutes%60;
    let day = 0;
    if( hr >= 24) {
      day = parseInt(hr/24);
      hr = hr%24;
    }
    return (day? day+ '天':'')+ (hr+ '小时')+ (min? min+ '分钟': '');
  }
}

/**
 * 发送报警 (本地发送)
 */
function sendAlarm(sensor, check, users, blocks) {
  let firstline = makeFirstline(sensor, check);
  let curtime = new Date().formatTime('yyyy-MM-dd hh:mm');
  let level = check.level;
  let levelName = level==0? '通知': (level==1? '预警': '报警');
  let color = level==0? '#16A765': (level==1? '#FFAD46': '#F83A22');
  let durat_str = formatDuration(check.duration);
  let lastline = (check.duration? '已持续约 '+ durat_str: '')+ (check.duration&&level? ', ': '') +(level? '请及时处理！':'');
  
  console.error('SendAlarm', curtime, sensor.name, check);
  
  users.forEach( function(user) {
    if(!user.openid)  return;
    
    // 传感器是否在用户的组？
    if( user.groups.indexOf(sensor.group) == -1) {
      return;
    }
    
    // 用户是否屏蔽该报警？
    let sid = sensor.id, uid = user.id;
    let until = blocks&&blocks[sid]&&blocks[sid][uid]? new Date(blocks[sid][uid]): null;
    if(until && until> new Date() && level> 0) { //复位通知不能屏蔽
      console.log('user <'+ uid+ '> blocks <'+ sid+ '> until', until.toLocaleString());
      return;
    }
    
    // 发送微信消息
    var templateId = 'zOVAEaSZVEHPdRE1KM2uQJy5wPfuWibHSU6NmXpIqF8';
    var url = WX_MSG_URL+ `?sid=${sid}&uid=${uid}`;
    var data = {
       "first": {
       "value": firstline, 
       "color":"#173177"
       },
       "keyword1":{
       "value": levelName,
       "color": color
       },
       "keyword2": {
       "value": curtime,
       "color":"#173177"
       },
       "keyword3": {
       "value": sensor.loc,
       "color":"#173177"
       },
       "keyword4": {
       "value": '何 138****1234',
       "color":"#173177"
       },
       "keyword5": {
       "value": 'n/a',
       "color":"#173177"
       },
       "remark":{
       "value": lastline,
       "color":"#173177"
       }
    };
    wechatApi.sendTemplate(user.openid, templateId, url, data, function(err, result) {
      //console.log('sendTemplate err+result:', err, result)
    })
  });
}

/**
 * 生成报警主提示 
 */
function makeFirstline(sensor, check) {
  //eg. sensor.name+ '温度超标！数值:'+ check.value+ ' 标准:'+ check.standard,
  let r = sensor.name+ ' ';
  switch (check.measure) {
    case 'temp':
      r += '温度' + (!check.is_reset? '超标': '复位')+ '！';
      r += '数值:' + check.value+ ' 标准:'+ check.standard;
      break;
    case 'offline':
      r += '离线' + (!check.is_reset? '报警': '复位')+ '！';
      r += !check.is_reset? '标准:'+ check.standard: '';
      break;
  }
  return r;
}

/**
 * 统计 tm 离线传感器并报警  
 */
function alarmTmOfflineSensors(sensors, users, blocks) {
  let offlines = sensors.filter(function(s) {
    return s.tm_offline;
  });
  
  let new_off_count = {};
  let new_off_snrs = groupBy(offlines, 'group');
  for( group in new_off_snrs) {
    new_off_count[group] = {};
    new_off_count[group]['num'] = new_off_snrs[group].length;
    new_off_count[group]['min_off'] = new_off_snrs[group][0].point.min_off;
  }
  console.log('old_off_count', tm_off_count);
  console.log('new_off_count', new_off_count);
  
  // 查找离线复位
  for( group in tm_off_count) {
    let od = tm_off_count[group];
    let nw = new_off_count[group];
    if(!nw) {
      let sensor = {
        name: '共计'+ od.num+ '个传感器',
        group: group,
        id: group+ '_group_offline',
        loc: groupName(group)+'-全库范围',
      };
      let check = {
        level: 0,
        duration: od.min_off+ INTV_MIN,
        measure: 'offline',
        is_reset: true,
        standard: '',
      };
      sendAlarm(sensor, check, users, blocks);
    }
  }
  
  // 查找离线报警
  for( group in new_off_count) {
    let od = tm_off_count[group];
    let nw = new_off_count[group];
    let exc_count = od ? od['exc_count']+1 : 1;
    let min_between = (exc_count-1)*INTV_MIN;
    nw['exc_count'] = exc_count;
    // console.log('min_between', min_between);
    
    if(!od || min_between%ALM_BETWEEN==0) {
      let sensor = {
        name: '共计'+ nw.num+ '个传感器',
        group: group,
        id: group+ '_group_offline',
        loc: groupName(group)+'-全库范围',
      };
      let check = {
        level: 2,
        duration: nw.min_off,
        measure: 'offline',
        is_reset: false,
        standard: '数据停止更新',
      };
      sendAlarm(sensor, check, users, blocks);
    }
  }
  
  // 保存新离线数量
  tm_off_count = new_off_count;
}

/**
 * 清理过期屏蔽项 
 *
 * 注意: 要全部清除屏蔽项时, 不能清空文件内容, 请手动把内容设置为 {}
 */
function cleanBlocks() {
  let count = 0;
  let blocks = JSON.parse(fs.readFileSync(BLOCK_FILE));
  
  console.log('------ cleanBlocks start ------------');
  for( sid in blocks) {
    for( uid in blocks[sid]) {
      let until = new Date(blocks[sid][uid]);
      let del = '';
      if( until< new Date()) {
        delete blocks[sid][uid];
        count++; del = '(deleted)';
      }
      console.log(sid, uid, until.toLocaleString(), del);
    }
  }
  
  fs.writeFileSync(BLOCK_FILE, JSON.stringify(blocks));
  return count;
}

/**
 * 发送 POST 请求 
 */
function postRequest(url, json, callback) {
  var options = {
    uri: url,
    method: 'POST',
    json: json,
  };
  request(options, callback);
}

// -- routers ------------------------------------------------------
app.get('/', function (req, res) {
  setTimeout(() => res.end('Hello sensor!'), Math.random() * 500);
})

app.get('/start', function (req, res) {
  startTimer(res);
});

app.get('/stop', function (req, res) {
  stopTimer(res);
});

/**
 * 临时屏蔽报警(表单)
 */
app.get('/blockme', function (req, res) {
  let sid = req.query.sid;
  let uid = req.query.uid;
  if(!sid || !uid) {
    return res.send('错误: 参数错误!');
  }
  
  let blocks = JSON.parse(fs.readFileSync(BLOCK_FILE));
  let until = blocks&&blocks[sid]&&blocks[sid][uid]? new Date(blocks[sid][uid]): null;
  if(until && until > new Date()) {
    res.render('blockme', {sid, uid, until: until.toLocaleString()});
  }
  else {
    res.render('blockme', {sid, uid, until:null});
  }
});

/**
 * 临时屏蔽报警(提交)
 */
app.post('/blockme', function (req, res) {
  let after = parseInt(req.body.after);
  let sid = req.body.sid;
  let uid = req.body.uid;
  
  if(!sid || !uid || !after) {
    return res.send('错误: 参数错误!');
  }
  
  let until = new Date().addHours(after);
  let blocks = JSON.parse(fs.readFileSync(BLOCK_FILE));
  blocks[sid] = {};
  blocks[sid][uid] = until;
  fs.writeFileSync(BLOCK_FILE, JSON.stringify(blocks));
  
  res.redirect('/blockme?sid='+ sid+ '&uid='+ uid+ '&v=2');
});

/**
 * 手动清理临时屏蔽报警过期项
 */
app.get('/cleanblocks', function (req, res) {
  let c = cleanBlocks();
  res.send(c+ ' expires cleaned!(see logs)');
});

// -- tests ------------------------------------------------------
app.get('/test', function (req, res) {
  // q format = `
    // SELECT last(value) FROM "li.base.v1.yum.fac" WHERE "where"='shenyang02' AND "where_type"='fac' AND "what_type"='env' AND "what1"='frig' AND "what2"='mt' AND "what3"='air' AND "output"='temp_c' AND "tool"='sample' AND "time_step"='5t' AND "at"='dock' GROUP BY "what4"
  // `;
  
  let tag1 = "measurement=li.base.v1.yum.fac,where_type=fac,where=shenyang02,what_type=env,what1=frig,what2=mt,what3=air,what4=h01,output=temp_c,tool=sample,time_step=5t,at=dock,where1=dl_1_1,where3=4m";
  let tag2 = "measurement=li.base.v1.yum.fac,where_type=fac,where=shenyang01,what_type=env,what1=frig,what2=lt,what3=air,what4=s10,output=temp_c,tool=sample,time_step=5t,at=room,where1=rl_1_1,where3=8_5m";
  let tag3 = "measurement=li.base.v1.yum.fac,where_type=fac,where=shenyang01,what_type=sys,what1=frig,what2=rcs,what3=offline,what4=A_power,output=status_u,tool=sample,time_step=5t";
  let m = parseTagMesa(tag1);
  let q = `SELECT last(value) FROM ${m.measurement} WHERE ${m.mesa_where}`;
  // 批量查询:
  // m = parseTagMesa(tag2);
  // q += `;SELECT last(value) FROM ${m.measurement} WHERE ${m.mesa_where}`;
  console.log('q:', q);
  
  influx.query(q).then(result => {
    res.json(result)
  }).catch(err => {
    res.status(500).send(err.stack)
  })
  //result: [{"time":"2018-05-07T09:00:00.000Z","last":14}]
  //result: [[{"time":"2018-05-09T06:15:00.000Z","last":12.9}],[{"time":"2018-05-09T06:20:00.000Z","last":-18.5}]]
});
  
app.get('/test-batch', function (req, res) {
  let offlines = sensors.filter(function(s) {
    return s.offline;
  });
  console.log('offlines', offlines);

  console.time('sensorBatchValues');
  sensorBatchValues(offlines, function(err, sensors) {
    console.log('Result sensors', sensors);
    console.timeEnd('sensorBatchValues');
    res.send('SensorBatchValues finished!');
  });
});

app.get('/test-blocks-r', function (req, res) {
  let file = './blocks_t.json'
  let result = JSON.parse(fs.readFileSync(file));
  let val = result['sydc2_lt_dock_01']['102'];
  let tm = new Date(val).toLocaleString();
  let later = (new Date(val) > new Date())? 'after now': 'before now';
  res.send(tm +','+ later);
});

app.get('/test-blocks-w', function (req, res) {
  let file = './blocks_t.json'
  let result = JSON.parse(fs.readFileSync(file));
  result['sydc2_lt_dock_01']['102'] = new Date().addHours(2);
  fs.writeFileSync(file, JSON.stringify(result));
  res.send('file written!');
});

app.get('/outdata', function (req, res) {
  out_value = req.query.v || 0;
  out_date = req.query.d || 0;
  res.send('out_value = '+ out_value+ ' out_date='+ out_date);
});

app.get('/auto-start', function (req, res) {
  autoStart(true);
  res.send('done!');
});

app.get('/array', function (req, res) {
  let test_count = {};
  test_count[1] = 1;
  test_count[2] = 2;
  console.log('test_count', test_count);
  test_count[1]++;
  console.log('test_count', test_count);
  res.send('done!');
});

app.get('/test8hr', function (req, res) {
  pool.query('SELECT count(*) AS cnt FROM users', function (error, results, fields) {
    if (error) throw error;
    res.send('The count is: '+ results[0].cnt);
  });
});

app.get('/test-request', function (req1, res1) {
  let json = {
    "token":"20185523",
    "mobile":"13011112222,13072168298",
    "firstline":"POSTMAN设备 温度超标！数值:15 标准:0~10",
    "level_name":"报警",
    "level_color":"#F83A22",
    "curtime":"2018-5-16 13:15",
    "location":"上海一号库",
    "contact":"测 138****2345",
    "workorder":"311429",
    "lastline":"已持续5小时, 请紧急处理！"
  };
  
  postRequest(KPI_SERVICE, json, function(err, resp, body) {
    console.log('request:', err, resp.statusCode, body);
  });
  
  res1.send('done!');
});
