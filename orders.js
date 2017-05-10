module.exports = (config, cookies, onOrders) => {
    var request = require('request');
    request = request.defaults({ jar: cookies });

    request.post({
        followAllRedirects: true,
        gzip: true,
        url: config.baseUri + config.order_path,
        form: {
            SearchType: 'simple',
            DatePattern: 'MM/dd/yyyy',
            TimePattern: 'h:mm a',
            PageNumberPrefix: 'PageNumber_',
            PageableName: 'OrdersPageable',
            CurrentPageNumber: 0,
            PageSize: 100
        }
    }, (error, res, body) => {
        if (res.statusCode == 200) {
            const cheerio = require('cheerio');
            const $ = cheerio.load(body);

            var orderTable = $($("form[name='OrderListForm'] > table")[0]);
            var rows = orderTable.find("tr");
            var fieldIndex = [];
            var orders = [];
            rows.map((i, e) => {
                var cols = $(e).find('td');
                var order = {};
                order['number'] = null;
                for (var i = 0; i < cols.length; i++) {
                    var col = $($(cols[i])[0]);
                    if (col[0].attribs && col[0].attribs.class && col[0].attribs.class.indexOf('table_header') >= 0) {
                        fieldIndex.push(col.text().toLowerCase().replace(' ', ''));
                    } else {
                        var combining = /[\u0300-\u036F]/g;
                        var text = col.text().trim().normalize('NFKD').replace(combining, '');
                        if (fieldIndex[i] == 'orderdate') {
                            var mdt = text.match(/(\d+\/\d+\/\d+.\d+:\d+:\d+.(am|pm))/i);
                            if (mdt && mdt.length > 0)
                                order[fieldIndex[i]] = new Date(mdt[0]);
                        } else if (fieldIndex[i] == 'total') {
                            order[fieldIndex[i]] = Number(text.replace(/[^0-9\.]+/g, ""));
                        } else {
                            order[fieldIndex[i]] = text;
                        }
                    }
                }
                if (order.number) orders.push(order);
            });

            if (onOrders) { onOrders(orders); }
        }

    });


};