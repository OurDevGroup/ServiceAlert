process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
var config = require('./config.json');

var login_failed_text = 'login_failed';
var instance = config.instance;
var login_path = '/on/demandware.store/Sites-Site/default/ViewApplication-ProcessLogin';
var service_path = '/on/demandware.store/Sites-Site/default/ServiceAnalytics-FetchStatOverview';
var base_path = '/on/demandware.store/Sites-Site/default/';

const maxData = config.maxData;
const queryInterval = config.queryInterval;

const twilio_accountSid = config.twilio_accountSid; // Your Account SID from www.twilio.com/console
const twilio_authToken = config.twilio_authToken; // Your Auth Token from www.twilio.com/console
const twilio_number = config.twilio_number;
const twilio_messageRate = config.twilio_messageRate; //frequency between service messages

const notify_number = config.notify_number;

const default_priority = 2; //2 deviations from normal

function auth(user, pass, onAuth) {
    var https = require('https');
    var cookies = [];
    https.get('https://' + instance + base_path, (res) => {
        res.headers['set-cookie'].map((cookie) => {
            var c = cookie.split(';');
            c.map((cook) => {
                var name = cook.substring(0, 4);
                if (name == 'sid=')
                    cookies.push(cook);
                if (name == 'dwsi')
                    cookies.push(cook);
            });
        });

        var options = {
            hostname: instance,
            port: 443,
            path: login_path,
            method: 'POST',
            headers: {
                'cookie': cookies.join(';'),
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'DemandwareServiceAlert',
                'Accept': '*/*',
                'content-length': '101'
            }
        }

        const req = https.request(options, (res) => {
            if (res.statusCode == 302) {
                cookies = [];
                res.headers['set-cookie'].map((cookie) => {
                    var c = cookie.split(';');
                    c.map((cook) => {
                        var name = cook.substring(0, 4);
                        if (name == 'sid=')
                            cookies.push(cook);
                        if (name == 'dwsi')
                            cookies.push(cook);
                    });
                });
                if (onAuth) {
                    onAuth(cookies)
                }
            } else {
                console.log("Unable to login, check username & password!");
                return;
            }
        });

        var querystring = require('querystring');

        var data = querystring.stringify({
            LoginForm_Password: pass,
            LoginForm_Login: user,
            LocaleID: '',
            LoginForm_RegistrationDomain: 'Sites'
        });

        req.write(data);

        req.end();

    }); //fetch cookie
} //auth

function fetchServiceStatus(onStats) {
    auth(config.user, config.password, (authCookies) => {
        var options = {
            hostname: instance,
            port: 443, //61835
            path: service_path,
            method: 'GET',
            headers: {
                'cookie': authCookies.join(';'),
                'User-Agent': 'DemandwareServiceAlert',
                'Accept': '*/*',
            }
        }

        var https = require('https');
        const req = https.request(options, (res) => {

            var bodyChunks = [];
            if (res.statusCode == 200) {
                res.on('data', function(chunk) {
                    bodyChunks.push(chunk);
                });
                res.on('end', function() {
                    jsonResp = Buffer.concat(bodyChunks).toString();

                    jsonResp = jsonResp.substring(2, jsonResp.length - 1);
                    jsonResp = jsonResp.replace('responseStatus', '"responseStatus"');
                    jsonResp = jsonResp.replace('responseText', '"responseText"');

                    var status = JSON.parse(jsonResp);

                    if (status && status.responseText.status.length > 0) {
                        status.responseText.status.map((status) => {
                            if ((status.headStat.error_rate && status.headStat.error_rate > 0) ||
                                (status.headStat.unavailable_rate && status.headStat.unavailable_rate > 0)) {
                                if (onStats) {
                                    onStats(status);
                                }
                                //console.log(status.id + " freaking sucks right now.");
                            }
                        });
                    }
                });
            }
        });
        req.end();
    });
} //fetch status

var runningStatus = {};
var startTime = Date.now();

function newStatCollection(defaults) {
    var newObj = {
        name: '',
        priority: default_priority,
        last_alert: 0,
        stats: {}
    }

    for (k in defaults) {
        newObj[k] = defaults[k];
    }

    return newObj;
}

function newStat() {
    return new function() {
        this.default = null;

        this.direction = 1; //-1 for negative
        this.getPreviousRate = () => {
            return this.history.length > 1 ? this.history[this.history.length - 2] : this.default;
        };

        this.getCurrentRate = () => {
            return this.history.length > 0 ? this.history[this.history.length - 1] : this.default;
        };

        this.getTotal = () => {
            var total = 0;
            this.history.map((v) => { total += v; });
            return total;
        };

        this.getMean = () => {
            var total = this.getTotal();
            return total / this.history.length;
        };

        this.getStandardDeviation = () => {
            var mean = this.getMean();
            var total = 0;
            this.history.map((v) => {
                total += Math.pow(v - mean, 2);
            });
            return Math.sqrt(total / this.history.length);
        };

        this.push = (val) => {
            this.history.push(val);
            if (this.history.length > maxData) {
                this.history.splice(0, this.history.length - maxData);
            }
            return val;
        };

        this.history = [];
    };
}

function computeStats() {
    fetchServiceStatus((status) => {
        if (!runningStatus[status.id]) {
            runningStatus[status.id] = newStatCollection({ name: status.id });
        }

        var s = runningStatus[status.id];
        var v = {};
        for (k in s.stats) {
            if (s.stats[k].default)
                v[k] = s.stats[k].default;
        }

        for (k in status.headStat) {
            v[k] = status.headStat[k];
        }

        for (k in v) {
            if (!s.stats[k])
                s.stats[k] = newStat();

            s.stats[k].push(v[k]);

            if (k == "error_rate" || k == "unavailable_rate") {
                s.stats[k].default = 0;
            } else {
                s.stats[k].default = null;
            }

            if (k == "success_rate")
                s.stats[k].direction = -1; //only care if the value is decreasing
        }

        for (k in s.stats) {
            var stat = s.stats[k];

            //don't bother checking unless you have a certain number of values
            if (stat.history.length >= maxData * .5) return;

            if (stat.getCurrentRate()) {
                if (stat.getCurrentRate() - stat.getMean() > stat.getStandardDeviation() * s.priority) {
                    var msg = s.name + " has an abnormal " + (stat.direction > 0 ? "increase" : "decrease") + " in " + k + " with a value of " + Number(stat.getCurrentRate()).toFixed(6);
                    console.log(msg);
                    if (s.last_alert + twilio_messageRate < Date.now()) {
                        alert(msg);
                        s.last_alert = Date.now();
                    }
                }
            }
        }

    });
}

function alert(message) {
    var twilio = require('twilio');

    var client = new twilio.RestClient(twilio_accountSid, twilio_authToken);

    client.messages.create({
        body: message,
        to: notify_number, // Text this number
        from: twilio_number
    }, function(err, message) {
        if (err) {
            console.error(err.message);
        }
    });

}

function run() {
    computeStats["kouponmedia.offersstate"] = newStatCollection({ name: "kouponmedia.offersstate", priority: 3 });
    computeStats["kouponmedia.loyalty"] = newStatCollection({ name: "kouponmedia.loyalty", priority: 3 });

    setInterval(computeStats, queryInterval);
};

run();