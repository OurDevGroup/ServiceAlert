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

var needsAuth = true;
var authCookies = [];

var request = require('request');
var cookies = request.jar();

config.baseUri = 'https://' + instance + (config.port ? ":" + config.port : '');
config.login_path = login_path;
config.base_path = base_path;
config.service_path = service_path;


function fetch(gotStats) {
    var fetch = require('./service.js');
    fetch(config, cookies, gotStats);
}

function fetchServiceStatus(gotStats) {
    if (!config.authenticated || !config.cookies) {
        auth(config.user, config.password, (cookies) => {
            config.authenticated = true;
            fetch(config.cookies, gotStats);
        });
    } else {
        fetch(config.cookies, gotStats);
    }
} //fetch status

var runningStatus = {};
var startTime = Date.now();

function newStatCollection(defaults) {
    var x = (defaults) => {
        var statCol = new function() {
            this.name = '';

            this.ignore = false;

            this.priority = default_priority;

            this.last_alert = 0;

            this.stats = {};
        }

        if (defaults) {
            for (k in defaults) {
                if (k != "stats") {
                    statCol[k] = defaults[k];
                }
            }
        }

        return statCol;
    };

    return x(defaults);
}

function newStat(defaults) {
    var x = (defaults) => {
        var stat = new function() {
            this.ignore = false;

            this.name = '';

            this.default = null;

            this.direction = 1; //-1 for negative

            this.getPreviousRate = () => {
                return this.history.length > 1 ? this.history[this.history.length - 2] : this.default;
            };

            this.getCurrentRate = () => {
                return this.history.length > 0 ? this.history[this.history.length - 1] : this.default;
            };

            this._total = null;

            this.getTotal = () => {
                var total = 0;
                this.history.map((v) => { total += v; });
                this._total = total;
                return total;
            };

            this._mean = null;

            this.getMean = () => {
                var total = this.getTotal();
                this._mean = total / this.history.length;
                return this._mean;
            };

            this._standardDeviation = null;

            this.getStandardDeviation = () => {
                var mean = this.getMean();
                var total = 0;
                this.history.map((v) => {
                    total += Math.pow(v - mean, 2);
                });
                this._standardDeviation = Math.sqrt(total / this.history.length);
                return this._standardDeviation;
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

        if (defaults) {
            for (key in defaults) {
                stat[key] = defaults[key];
            }
        }

        return stat;
    };
    return x(defaults);
}

function computeStats() {
    fetchServiceStatus((status) => {
        if (!runningStatus[status.id]) {
            runningStatus[status.id] = newStatCollection({ name: status.id });
            if (config.console && config.verbose) console.log("Logging " + status.id + " as new service.");
        }

        var s = runningStatus[status.id];

        if (s.ignore) return;

        var v = {};
        for (k in s.stats) {
            if (s.stats[k].ignore) continue;
            if (s.stats[k].default) {
                v[k] = s.stats[k].default;
            }
        }

        for (k in status.headStat) {
            if (s.stats[k] && s.stats[k].ignore) continue;
            v[k] = status.headStat[k];
        }

        for (k in v) {

            if (!s.stats[k] || typeof s.stats[k] === 'undefined') {
                if (config.services &&
                    config.services[status.id] &&
                    config.services[status.id].stats &&
                    config.services[status.id].stats[k]) {
                    var d = config.services[status.id].stats[k];
                    if (!d.name) d['name'] = k;
                    s.stats[k] = newStat(d);
                } else {
                    s.stats[k] = newStat({ name: k });
                }
                if (config.console && config.verbose) console.log("Logging " + k + " as new metric for " + status.id + ".");
            }

            s.stats[k].push(v[k]);
            if (config.console && config.verbose) console.log("Pushing " + v[k] + " to " + status.id + "." + k);

            var fs = require('fs');
            fs.writeFileSync('./data.json', JSON.stringify(runningStatus, null, 2), 'utf-8');

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
            if (stat.history.length >= (config.minData || 20)) {
                if ((stat.getPreviousRate() - stat.getCurrentRate()) * stat.direction < 0) {
                    if (stat.getCurrentRate()) {
                        if (stat.getCurrentRate() - stat.getMean() > stat.getStandardDeviation() * s.priority) {
                            var msg = s.name + " has an abnormal " + (stat.direction > 0 ? "increase" : "decrease") + " in " + stat.name + " with a value of " + Number(stat.getCurrentRate()).toFixed(6);
                            if (config.console) console.log(msg);
                            if (s.last_alert + twilio_messageRate < Date.now()) {
                                alert(msg);
                                s.last_alert = Date.now();
                            }
                        }
                    }
                }
            }
        }

    });
}

function alert(message) {
    if (!config.twilio) return;
    if (config.console) console.log("Sending message to Twilio.");
    if (twilio_accountSid && twilio_authToken) {
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

}

function restoreState(prev) {
    if (config.console) console.log("Restoring previous state.");
    if (prev) {
        for (svcName in prev) {
            var svc = prev[svcName];

            var defaults = {};
            for (k in svc) {
                if (typeof svc[k] !== 'object' && typeof svc[k] !== 'function') {
                    defaults[k] = svc[k];
                }
            }
            runningStatus[svcName] = newStatCollection(defaults);
            if (svc['stats']) {
                for (metricName in svc.stats) {
                    var stat = svc.stats[metricName]; //error_rate                    
                    defaults = {};
                    for (k in stat) {
                        if (typeof stat[k] !== 'object' && typeof stat[k] !== 'function') {
                            defaults[k] = stat[k];
                        }
                    }
                    runningStatus[svcName].stats[metricName] = newStat(defaults);
                    if (stat.history) {
                        for (h in stat.history) {
                            runningStatus[svcName].stats[metricName].history.push(stat.history[h]);
                        }
                    }
                }
            }
        }
    }
}



process.argv.forEach(function(val, index, array) {
    switch (val) {
        case "--help":
            console.log("--help  \tHelp for the command line.\n--restore\tRestore previous data state instead of starting a new one.\n--console\tOutput information to the console window.\n--twilio\tSend messages via Twilio\n--verbose\tBe more verbose on messages.");
            process.exit(1);
            break;
        case "--restore":
            var fs = require('fs');
            if (fs.existsSync('./data.json')) {
                config.restore = true;
                runningStatus = require('./data.json');
                restoreState(runningStatus);
            }
            break;
        case "--console":
            config.console = true;
            break;
        case "--twilio":
            config.twilio = true;
            break;
        case "--verbose":
            config.verbose = true;
            break;
    }
});

function auth(username, password, onAuthenticated) {
    const auth = require('./auth.js');
    auth(config, cookies, username, password, onAuthenticated);
}

function fetchOrders(authCookies, gotOrders) {
    var querystring = require('querystring');

    var postData = querystring.stringify({
        PageSize: 100,
        CurrentPageNumber: 0
    });

    var options = {
        hostname: instance,
        port: config.port || 443,
        path: '/on/demandware.store/Sites-Site/default/ViewOrderList_52-Dispatch',
        method: 'POST',
        headers: {
            'cookie': authCookies.join(';'),
            'User-Agent': 'DemandwareServiceAlert',
            'Accept': '*/*',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': postData.length
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
                bodyResp = Buffer.concat(bodyChunks).toString();

                const cheerio = require('cheerio');
                const $ = cheerio.load(bodyResp);

                var fs = require('fs');
                fs.writeFileSync('./test.html', bodyResp, 'utf-8');

                console.log(bodyResp);
            });
        }
    });

    req.write(postData);

    req.end();
}

if ((!config.instance || config.instance.length == 0) && config.console) console.log("Unable to log data, missing instance name.");

if (!config.site && config.console) console.log("Unable to log order data, missing site name.");

function run() {
    if (config.services && !config.restore) {
        for (s in config.services) {
            runningStatus[s] = newStatCollection(config.services[s]);
        }
    }

    setInterval(computeStats, queryInterval);
};

run();
/*
auth(config.user, config.password, () => {
    console.log("authenticated");
    var getSites = require('./site.js');
    getSites(config, cookies, () => {
        console.log('done');

        var getOrders = require('./orders.js');
        getOrders(config, cookies, (orders) => {
            console.log(orders)
        });

    });
});*/