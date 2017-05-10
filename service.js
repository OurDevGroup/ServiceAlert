module.exports = (config, cookies, onStat) => {
    var request = require('request');
    request = request.defaults({ jar: cookies });

    if (config.console && config.verbose) console.log("Fetching stats.");

    request.get({
        followAllRedirects: true,
        gzip: true,
        url: config.baseUri + config.service_path
    }, (error, res, body) => {
        if (res.statusCode == 200) {

            if (config.console && config.verbose) console.log("Got stats.");

            var jsonResp = body.substring(2, body.length - 1);;
            jsonResp = jsonResp.replace('responseStatus', '"responseStatus"');
            jsonResp = jsonResp.replace('responseText', '"responseText"');

            var status = JSON.parse(jsonResp);

            if (status && status.responseText.status.length > 0) {
                status.responseText.status.map((status) => {
                    if ((status.headStat.error_rate && status.headStat.error_rate > 0) ||
                        (status.headStat.unavailable_rate && status.headStat.unavailable_rate > 0)) {
                        if (onStat) {
                            onStat(status);
                        }
                    }
                });
            } //status length

        } // 200


    });
};